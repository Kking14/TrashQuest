#include <ArduinoJson.h>

// TrashQuest ESP32 controller. ArduinoJson 7.x is required.
// Serial protocol: one JSON object per line at 115200 baud.

const int inductivePin = 26;  // active-low NPN tin-can sensor
const int dirPin = 32;
const int pulPin = 33;
const int servoPin = 25;
const int trigPin = 27;       // ultrasonic fullness only
const int echoPin = 14;       // use a 5 V-to-3.3 V divider

const int stepsPerRevolution = 200;
const int sortingAngleDegrees = 180;
const int moveSteps = (stepsPerRevolution * sortingAngleDegrees) / 360;
const unsigned long stepHalfPeriodUs = 3000;
const int servoNormalAngle = -20;
const int servoMaterialDownAngle = 60;
const int servoPaperDownAngle = 90;
const int servoMinimumPulseUs = 500;
const int servoMaximumPulseUs = 2400;
const int servoPwmFrequencyHz = 50;
const int servoPwmResolutionBits = 16;
const unsigned long servoStepIntervalMs = 1;
const unsigned long gateOpenHoldMs = 3000;
const unsigned long homeHoldMs = 3000;
const bool metalDirection = HIGH;
const bool plasticDirection = LOW;

const unsigned long aiWaitTimeoutMs = 8000;
const unsigned long confirmationTimeoutMs = 120000;
const unsigned long motorTimeoutMs = 30000;
const unsigned long platformEmptyTimeoutMs = 120000;
const unsigned long partialJsonTimeoutMs = 300;
const unsigned long inductiveDebounceMs = 150;
const unsigned long inductiveEmptyDebounceMs = 350;

const float fullDistanceCm = 10.0;
const int fullnessConfirms = 3;
const unsigned long fullnessSampleIntervalMs = 1000;
const unsigned long fullnessHeartbeatMs = 60000;
const unsigned long ultrasonicTimeoutUs = 25000;

enum ControllerState {
  IDLE,
  DETECTING,
  WAITING_FOR_AI,
  WAITING_FOR_CONFIRMATION,
  SORTING,
  WAITING_FOR_PLATFORM_EMPTY,
  ERROR_RECOVERY
};

enum SortPhase {
  SORT_NONE,
  STEPPER_OUT,
  PAUSE_AFTER_OUT,
  SERVO_DOWN,
  HOLD_GATE_OPEN,
  SERVO_HOME,
  PAUSE_BEFORE_RETURN,
  STEPPER_RETURN,
  SORT_DONE
};

ControllerState controllerState = IDLE;
SortPhase sortPhase = SORT_NONE;
unsigned long stateStartedAt = 0;
unsigned long phaseStartedAt = 0;
String activeDetectionId;
String activeWasteType;
int activeItemCount = 0;
bool activeOutwardDirection = LOW;

// Bounded serial line buffer; malformed/partial input never blocks loop().
char serialBuffer[512];
size_t serialLength = 0;
unsigned long lastSerialByteAt = 0;

// Incremental stepper state.
bool stepperBusy = false;
bool stepPulseHigh = false;
int remainingSteps = 0;
unsigned long nextStepToggleUs = 0;

// Incremental servo target driven by the ESP32's hardware PWM peripheral.
int servoCurrentAngle = servoNormalAngle;
int servoTargetAngle = servoNormalAngle;
unsigned long lastServoStepAt = 0;
bool servoPwmReady = false;

// Inductive detection only confirms metal; it never implies plastic.
bool inductiveArmed = true;
unsigned long inductiveActiveSince = 0;
unsigned long inductiveEmptySince = 0;
bool inductiveEmptyReported = false;

// Fullness monitoring remains independent of classification.
unsigned long lastFullnessSampleAt = 0;
unsigned long lastFullnessReportAt = 0;
int fullConfirmCount = 0;
int availableConfirmCount = 0;
bool binFull = false;
bool hasFullnessReport = false;

const char *stateName(ControllerState state) {
  switch (state) {
    case IDLE: return "IDLE";
    case DETECTING: return "DETECTING";
    case WAITING_FOR_AI: return "WAITING_FOR_AI";
    case WAITING_FOR_CONFIRMATION: return "WAITING_FOR_CONFIRMATION";
    case SORTING: return "SORTING";
    case WAITING_FOR_PLATFORM_EMPTY: return "WAITING_FOR_PLATFORM_EMPTY";
    case ERROR_RECOVERY: return "ERROR_RECOVERY";
  }
  return "UNKNOWN";
}

void sendEvent(const char *eventName, bool success = true, const char *messageText = nullptr) {
  JsonDocument message;
  message["event"] = eventName;
  if (activeDetectionId.length()) message["detectionId"] = activeDetectionId;
  message["success"] = success;
  message["state"] = stateName(controllerState);
  if (messageText) message["message"] = messageText;
  serializeJson(message, Serial);
  Serial.println();
}

void setState(ControllerState nextState) {
  controllerState = nextState;
  stateStartedAt = millis();
  sendEvent("status");
}

void clearBatch() {
  activeDetectionId = "";
  activeWasteType = "";
  activeItemCount = 0;
  sortPhase = SORT_NONE;
  inductiveEmptySince = 0;
  inductiveEmptyReported = false;
}

void safeMotorStop() {
  digitalWrite(pulPin, LOW);
  stepperBusy = false;
  stepPulseHigh = false;
  remainingSteps = 0;
  servoTargetAngle = servoNormalAngle;
}

void recoverToIdle(const char *reason) {
  safeMotorStop();
  setState(ERROR_RECOVERY);
  sendEvent("error", false, reason);
}

void startStepper(int steps, bool direction) {
  digitalWrite(pulPin, LOW);
  digitalWrite(dirPin, direction);
  remainingSteps = max(0, steps);
  stepPulseHigh = false;
  stepperBusy = remainingSteps > 0;
  nextStepToggleUs = micros() + 100;
}

void updateStepper() {
  if (!stepperBusy) return;
  unsigned long now = micros();
  if ((long)(now - nextStepToggleUs) < 0) return;
  stepPulseHigh = !stepPulseHigh;
  digitalWrite(pulPin, stepPulseHigh ? HIGH : LOW);
  nextStepToggleUs = now + stepHalfPeriodUs;
  if (!stepPulseHigh) {
    remainingSteps--;
    if (remainingSteps <= 0) {
      stepperBusy = false;
      digitalWrite(pulPin, LOW);
    }
  }
}

int servoPulseWidthUs(int angle) {
  return map(constrain(angle, -20, 180), -20, 180, servoMinimumPulseUs, servoMaximumPulseUs);
}

void writeServoAngle(int angle) {
  if (!servoPwmReady) return;
  const uint32_t maximumDuty = (1UL << servoPwmResolutionBits) - 1;
  const uint32_t duty = ((uint32_t)servoPulseWidthUs(angle) * maximumDuty) / 20000UL;
  ledcWrite(servoPin, duty);
}

void updateServo() {
  unsigned long nowMs = millis();
  if (servoCurrentAngle != servoTargetAngle && nowMs - lastServoStepAt >= servoStepIntervalMs) {
    servoCurrentAngle += servoTargetAngle > servoCurrentAngle ? 1 : -1;
    lastServoStepAt = nowMs;
    writeServoAngle(servoCurrentAngle);
  }
}

void enterSortPhase(SortPhase phase) {
  sortPhase = phase;
  phaseStartedAt = millis();
  if (phase == STEPPER_OUT) startStepper(moveSteps, activeOutwardDirection);
  if (phase == SERVO_DOWN) {
    servoTargetAngle = activeWasteType == "Paper" ? servoPaperDownAngle : servoMaterialDownAngle;
  }
  if (phase == SERVO_HOME) servoTargetAngle = servoNormalAngle;
  if (phase == STEPPER_RETURN) startStepper(moveSteps, !activeOutwardDirection);
}

void beginSort() {
  setState(SORTING);
  if (activeWasteType == "Paper") enterSortPhase(SERVO_DOWN);
  else enterSortPhase(STEPPER_OUT);
}

void updateSorting() {
  if (millis() - stateStartedAt > motorTimeoutMs) {
    recoverToIdle("Motor operation timed out");
    return;
  }
  switch (sortPhase) {
    case STEPPER_OUT:
      if (!stepperBusy) enterSortPhase(PAUSE_AFTER_OUT);
      break;
    case PAUSE_AFTER_OUT:
      if (millis() - phaseStartedAt >= 700) enterSortPhase(SERVO_DOWN);
      break;
    case SERVO_DOWN:
      if (servoCurrentAngle == servoTargetAngle) enterSortPhase(HOLD_GATE_OPEN);
      break;
    case HOLD_GATE_OPEN:
      if (millis() - phaseStartedAt >= gateOpenHoldMs) enterSortPhase(SERVO_HOME);
      break;
    case SERVO_HOME:
      if (servoCurrentAngle == servoTargetAngle) enterSortPhase(PAUSE_BEFORE_RETURN);
      break;
    case PAUSE_BEFORE_RETURN:
      if (millis() - phaseStartedAt >= homeHoldMs) {
        if (activeWasteType == "Paper") enterSortPhase(SORT_DONE);
        else enterSortPhase(STEPPER_RETURN);
      }
      break;
    case STEPPER_RETURN:
      if (!stepperBusy) enterSortPhase(SORT_DONE);
      break;
    case SORT_DONE:
      sendEvent("sorted", true);
      setState(WAITING_FOR_PLATFORM_EMPTY);
      break;
    default:
      recoverToIdle("Invalid sorting phase");
  }
}

bool supportedWasteType(const String &wasteType) {
  return wasteType == "Paper" || wasteType == "Plastic" || wasteType == "Tin Can";
}

void processCommand(const char *line) {
  JsonDocument command;
  DeserializationError error = deserializeJson(command, line);
  if (error) {
    sendEvent("serial_error", false, "Malformed JSON ignored");
    return;
  }
  String action = command["command"] | "";
  String detectionId = command["detectionId"] | "";
  String wasteType = command["wasteType"] | "";
  int itemCount = command["itemCount"] | 1;

  if (action == "recover") {
    if (!activeDetectionId.length() || detectionId == activeDetectionId) recoverToIdle("Recovery requested by gateway");
    return;
  }
  if (action == "platform_empty") {
    if (controllerState == WAITING_FOR_PLATFORM_EMPTY && detectionId == activeDetectionId) {
      clearBatch();
      setState(IDLE);
      sendEvent("ready");
    }
    return;
  }
  if (action == "prepare") {
    if (binFull) {
      activeDetectionId = detectionId;
      sendEvent("rejected", false, "Bin is full");
      clearBatch();
      return;
    }
    bool canReserve = controllerState == IDLE || controllerState == DETECTING || controllerState == WAITING_FOR_AI;
    if (!canReserve || !detectionId.length() || !supportedWasteType(wasteType) || itemCount < 1) {
      sendEvent("busy", false, "Station cannot reserve this batch");
      return;
    }
    activeDetectionId = detectionId;
    activeWasteType = wasteType;
    activeItemCount = itemCount;
    setState(WAITING_FOR_CONFIRMATION);
    sendEvent("prepared");
    return;
  }
  if (detectionId != activeDetectionId) {
    sendEvent("stale_command", false, "Detection ID does not match active batch");
    return;
  }
  if (action == "reject" && controllerState == WAITING_FOR_CONFIRMATION) {
    sendEvent("rejected");
    setState(WAITING_FOR_PLATFORM_EMPTY);
    return;
  }
  if (action == "sort" && controllerState == WAITING_FOR_CONFIRMATION) {
    if (binFull) {
      sendEvent("sorted", false, "Bin became full before sorting");
      setState(WAITING_FOR_PLATFORM_EMPTY);
      return;
    }
    if (!supportedWasteType(wasteType) || wasteType != activeWasteType) {
      sendEvent("sorted", false, "Unsupported or mismatched waste type");
      setState(WAITING_FOR_PLATFORM_EMPTY);
      return;
    }
    activeOutwardDirection = wasteType == "Tin Can" ? metalDirection : plasticDirection;
    beginSort();
  }
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char value = (char)Serial.read();
    lastSerialByteAt = millis();
    if (value == '\r') continue;
    if (value == '\n') {
      serialBuffer[serialLength] = '\0';
      if (serialLength > 0) processCommand(serialBuffer);
      serialLength = 0;
    } else if (serialLength < sizeof(serialBuffer) - 1) {
      serialBuffer[serialLength++] = value;
    } else {
      serialLength = 0;
      sendEvent("serial_error", false, "Serial JSON exceeded buffer");
    }
  }
  if (serialLength > 0 && millis() - lastSerialByteAt > partialJsonTimeoutMs) {
    serialLength = 0;
    sendEvent("serial_error", false, "Partial serial JSON timed out");
  }
}

void updateInductiveSensor() {
  bool metalActive = digitalRead(inductivePin) == LOW;

  // Metal bypasses camera detection, so sensor release is also the reliable
  // platform-empty signal that rearms the kiosk after sorting.
  if (controllerState == WAITING_FOR_PLATFORM_EMPTY && activeWasteType == "Tin Can") {
    if (metalActive) {
      inductiveEmptySince = 0;
      return;
    }
    if (inductiveEmptyReported) return;
    if (inductiveEmptySince == 0) {
      inductiveEmptySince = millis();
      return;
    }
    if (millis() - inductiveEmptySince >= inductiveEmptyDebounceMs) {
      inductiveEmptyReported = true;
      sendEvent("platform_empty", true, "Inductive sensor is clear");
    }
    return;
  }

  if (!metalActive) {
    inductiveArmed = true;
    inductiveActiveSince = 0;
    inductiveEmptySince = 0;
    if (controllerState == DETECTING) setState(IDLE);
    return;
  }
  if (!inductiveArmed || binFull || (controllerState != IDLE && controllerState != DETECTING)) return;
  if (inductiveActiveSince == 0) {
    inductiveActiveSince = millis();
    setState(DETECTING);
    return;
  }
  if (millis() - inductiveActiveSince >= inductiveDebounceMs) {
    inductiveArmed = false;
    activeDetectionId = "inductive-" + String(millis());
    setState(WAITING_FOR_AI);
    sendEvent("inductive_detected", true, "Tin can detected; waiting for gateway confirmation");
  }
}

void updateFullness() {
  unsigned long now = millis();
  if (now - lastFullnessSampleAt < fullnessSampleIntervalMs) return;
  lastFullnessSampleAt = now;
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  unsigned long duration = pulseIn(echoPin, HIGH, ultrasonicTimeoutUs);
  if (duration == 0) {
    sendEvent("ultrasonic_timeout", false, "No bounded echo received");
    return;
  }
  float distanceCm = duration * 0.0343 / 2.0;
  if (distanceCm < 1.0 || distanceCm > 400.0) return;
  bool fullNow = distanceCm <= fullDistanceCm;
  if (fullNow) {
    fullConfirmCount++;
    availableConfirmCount = 0;
  } else {
    availableConfirmCount++;
    fullConfirmCount = 0;
  }
  if (fullConfirmCount < fullnessConfirms && availableConfirmCount < fullnessConfirms) return;
  bool shouldReport = !hasFullnessReport || binFull != fullNow || now - lastFullnessReportAt >= fullnessHeartbeatMs;
  if (!shouldReport) return;
  binFull = fullNow;
  JsonDocument message;
  message["event"] = "bin_fullness";
  message["isFull"] = binFull;
  message["distanceCm"] = round(distanceCm * 10.0) / 10.0;
  message["state"] = stateName(controllerState);
  serializeJson(message, Serial);
  Serial.println();
  hasFullnessReport = true;
  lastFullnessReportAt = now;
}

void updateTimeoutsAndRecovery() {
  unsigned long elapsed = millis() - stateStartedAt;
  if (controllerState == WAITING_FOR_AI && elapsed > aiWaitTimeoutMs) {
    sendEvent("timeout", false, "AI result timed out");
    clearBatch();
    setState(IDLE);
  } else if (controllerState == WAITING_FOR_CONFIRMATION && elapsed > confirmationTimeoutMs) {
    sendEvent("timeout", false, "Confirmation timed out");
    setState(WAITING_FOR_PLATFORM_EMPTY);
  } else if (controllerState == WAITING_FOR_PLATFORM_EMPTY && elapsed > platformEmptyTimeoutMs) {
    recoverToIdle("Platform-empty signal timed out");
  } else if (controllerState == ERROR_RECOVERY && servoCurrentAngle == servoNormalAngle) {
    clearBatch();
    setState(IDLE);
    sendEvent("ready");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(inductivePin, INPUT_PULLUP);
  pinMode(dirPin, OUTPUT);
  pinMode(pulPin, OUTPUT);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  digitalWrite(dirPin, LOW);
  digitalWrite(pulPin, LOW);
  digitalWrite(trigPin, LOW);
  servoPwmReady = ledcAttach(servoPin, servoPwmFrequencyHz, servoPwmResolutionBits);
  writeServoAngle(servoNormalAngle);
  stateStartedAt = millis();
  sendEvent("ready");
  if (!servoPwmReady) sendEvent("servo_error", false, "Could not attach GPIO 25 hardware PWM");
}

void loop() {
  readSerialCommands();
  updateServo();
  updateStepper();
  updateFullness();
  updateInductiveSensor();
  if (controllerState == SORTING) updateSorting();
  updateTimeoutsAndRecovery();
}
