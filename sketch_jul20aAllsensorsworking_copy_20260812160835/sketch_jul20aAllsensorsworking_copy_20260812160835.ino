#include <ArduinoJson.h>

// TrashQuest ESP32 controller. ArduinoJson 7.x is required.
// Serial protocol: one JSON object per line at 115200 baud.

const int inductivePin = 26;  // active-low NPN tin-can sensor
const int dirPin = 32;
const int pulPin = 33;
const int servoPin = 25;
const int trigPin = 27;       // plastic-bin ultrasonic
const int echoPin = 14;       // each ECHO needs its own 5 V-to-3.3 V divider
const int metalTrigPin = 16;
const int metalEchoPin = 34;

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
const unsigned long homeHoldMs = 750;  // allow the physical servo to settle before rotating home
const bool metalDirection = HIGH;
const bool plasticDirection = LOW;

const unsigned long aiWaitTimeoutMs = 8000;
const unsigned long confirmationTimeoutMs = 120000;
const unsigned long motorTimeoutMs = 30000;
const unsigned long platformEmptyTimeoutMs = 120000;
const unsigned long partialJsonTimeoutMs = 300;
const unsigned long inductiveDebounceMs = 150;
const unsigned long inductiveEmptyDebounceMs = 2000;

const float plasticFullDistanceCm = 10.0;
const float metalFullDistanceCm = 10.0;
const int fullnessConfirms = 3;
const unsigned long fullnessSampleIntervalMs = 500;  // alternate bins; each sampled once per second
const unsigned long fullnessHeartbeatMs = 10000;
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
bool reportedMetalActive = false;
bool hasMetalStateReport = false;
unsigned long lastMetalStateReportAt = 0;
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
bool manualRecoveryRequired = false;

// Fullness monitoring remains independent of classification.
unsigned long lastFullnessSampleAt = 0;
bool binFull = false;
struct BinFullness {
  const char *name;
  int trig;
  int echo;
  float threshold;
  bool isFull = false;
  bool readingValid = false;
  bool hasReport = false;
  unsigned long lastReportAt = 0;
  int fullCount = 0;
  int availableCount = 0;
};
BinFullness fullnessSensors[2] = {
  {"plastic", trigPin, echoPin, plasticFullDistanceCm},
  {"metal", metalTrigPin, metalEchoPin, metalFullDistanceCm}
};
int nextFullnessSensor = 0;

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
  if (manualRecoveryRequired) message["requiresManualReset"] = true;
  if (messageText) message["message"] = messageText;
  serializeJson(message, Serial);
  Serial.println();
}

void setState(ControllerState nextState) {
  controllerState = nextState;
  stateStartedAt = millis();
  // Clear time observed during motion must never count toward rearming.
  inductiveEmptySince = 0;
  inductiveEmptyReported = false;
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
  // A stopped move may leave the platform away from home. It must be checked
  // and returned home manually before restarting the ESP32 with its EN button.
  manualRecoveryRequired = manualRecoveryRequired || controllerState == SORTING
      || controllerState == WAITING_FOR_PLATFORM_EMPTY;
  inductiveArmed = false;
  inductiveActiveSince = 0;
  safeMotorStop();
  setState(ERROR_RECOVERY);
  String notice = String(reason) + (manualRecoveryRequired
      ? ". Sorting locked. Remove the waste, check the mechanism and return it home, then press ESP32 EN to restart."
      : ". Remove the waste; waiting for the metal sensor to stay clear.");
  sendEvent("error", false, notice.c_str());
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
      if (activeWasteType == "Tin Can") {
        // Only acknowledge our own post-cycle clear report, never an early
        // camera/gateway message. If metal returned since the report, stay
        // disarmed in IDLE until a new continuous clear interval completes.
        if (!inductiveEmptyReported) return;
        inductiveArmed = digitalRead(inductivePin) != LOW;
        inductiveActiveSince = 0;
      }
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
    if (wasteType == "Tin Can") {
      // The sensor creates the reservation once. A bouncing sensor or a
      // repeated command cannot create another metal transaction.
      canReserve = controllerState == WAITING_FOR_AI && detectionId == activeDetectionId;
    }
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
    if (activeWasteType != "Tin Can" && digitalRead(inductivePin) == LOW) {
      safeMotorStop();
      setState(WAITING_FOR_PLATFORM_EMPTY);
      sendEvent("mixed_waste_detected", false, "Metal and camera waste detected together");
      return;
    }
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
  // Report presence independently of the transaction state, including while sorting.
  if (!hasMetalStateReport || metalActive != reportedMetalActive || millis() - lastMetalStateReportAt >= 1000) {
    JsonDocument message;
    message["event"] = "inductive_state";
    message["active"] = metalActive;
    serializeJson(message, Serial);
    Serial.println();
    reportedMetalActive = metalActive;
    hasMetalStateReport = true;
    lastMetalStateReportAt = millis();
  }
  if (metalActive && controllerState == SORTING && activeWasteType != "Tin Can") {
    safeMotorStop();
    setState(WAITING_FOR_PLATFORM_EMPTY);
    sendEvent("mixed_waste_detected", false, "Metal and camera waste detected together");
    return;
  }

  // Sensor clearance is only a proximity check, not proof that waste fell.
  // Start this interval only after the gate and stepper finish the full cycle.
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

  // Continue reporting presence for the mixed-waste interlock, but do not
  // rearm or reserve another item during preparation, motion or recovery.
  if (controllerState != IDLE && controllerState != DETECTING) return;

  if (!metalActive) {
    inductiveActiveSince = 0;
    if (controllerState == DETECTING) setState(IDLE);
    if (!inductiveArmed) {
      if (inductiveEmptySince == 0) inductiveEmptySince = millis();
      if (millis() - inductiveEmptySince >= inductiveEmptyDebounceMs) {
        inductiveArmed = true;
        inductiveEmptySince = 0;
      }
    }
    return;
  }
  inductiveEmptySince = 0;
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
  // pulseIn can block for 25 ms. Do not stretch stepper pulses with an echo
  // wait; resume fullness measurements when the motor stops.
  if (stepperBusy) return;
  unsigned long now = millis();
  if (now - lastFullnessSampleAt < fullnessSampleIntervalMs) return;
  lastFullnessSampleAt = now;
  BinFullness &sensor = fullnessSensors[nextFullnessSensor];
  nextFullnessSensor = (nextFullnessSensor + 1) % 2;
  digitalWrite(sensor.trig, LOW);
  delayMicroseconds(2);
  digitalWrite(sensor.trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(sensor.trig, LOW);
  unsigned long duration = pulseIn(sensor.echo, HIGH, ultrasonicTimeoutUs);
  float distanceCm = duration * 0.0343 / 2.0;
  bool valid = duration > 0 && distanceCm >= 1.0 && distanceCm <= 400.0;
  bool oldFull = sensor.isFull;
  bool oldValid = sensor.readingValid;
  if (!valid) {
    sensor.readingValid = false;
    sensor.fullCount = 0;
    sensor.availableCount = 0;
  } else {
    bool fullNow = distanceCm <= sensor.threshold;
    if (fullNow) {
      sensor.fullCount = min(fullnessConfirms, sensor.fullCount + 1);
      sensor.availableCount = 0;
    } else {
      sensor.availableCount = min(fullnessConfirms, sensor.availableCount + 1);
      sensor.fullCount = 0;
    }
    if (sensor.fullCount >= fullnessConfirms || sensor.availableCount >= fullnessConfirms) {
      sensor.isFull = fullNow;
      sensor.readingValid = true;
    }
  }
  binFull = fullnessSensors[0].isFull || fullnessSensors[1].isFull;
  bool shouldReport = !sensor.hasReport || oldFull != sensor.isFull || oldValid != sensor.readingValid
      || now - sensor.lastReportAt >= fullnessHeartbeatMs;
  if (!shouldReport) return;
  JsonDocument message;
  message["event"] = "bin_fullness";
  message["binType"] = sensor.name;
  message["isFull"] = sensor.isFull;
  message["stationFull"] = binFull;
  message["readingValid"] = sensor.readingValid;
  if (valid) message["distanceCm"] = round(distanceCm * 10.0) / 10.0;
  else message["distanceCm"] = nullptr;
  message["state"] = stateName(controllerState);
  serializeJson(message, Serial);
  Serial.println();
  sensor.hasReport = true;
  sensor.lastReportAt = now;
}

void updateTimeoutsAndRecovery() {
  unsigned long elapsed = millis() - stateStartedAt;
  if (controllerState == WAITING_FOR_AI && elapsed > aiWaitTimeoutMs) {
    recoverToIdle("AI result timed out");
  } else if (controllerState == WAITING_FOR_CONFIRMATION && elapsed > confirmationTimeoutMs) {
    sendEvent("timeout", false, "Confirmation timed out");
    setState(WAITING_FOR_PLATFORM_EMPTY);
  } else if (controllerState == WAITING_FOR_PLATFORM_EMPTY && elapsed > platformEmptyTimeoutMs) {
    recoverToIdle("Platform-empty signal timed out");
  } else if (controllerState == ERROR_RECOVERY && servoCurrentAngle == servoNormalAngle) {
    if (manualRecoveryRequired) return;
    if (digitalRead(inductivePin) == LOW) {
      inductiveEmptySince = 0;
      return;
    }
    if (inductiveEmptySince == 0) inductiveEmptySince = millis();
    if (millis() - inductiveEmptySince >= inductiveEmptyDebounceMs) {
      clearBatch();
      inductiveArmed = true;
      inductiveActiveSince = 0;
      setState(IDLE);
      sendEvent("ready");
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(inductivePin, INPUT_PULLUP);
  pinMode(dirPin, OUTPUT);
  pinMode(pulPin, OUTPUT);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(metalTrigPin, OUTPUT);
  pinMode(metalEchoPin, INPUT);
  digitalWrite(metalTrigPin, LOW);
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
  updateInductiveSensor();
  readSerialCommands();
  updateServo();
  updateStepper();
  updateFullness();
  if (controllerState == SORTING) updateSorting();
  updateTimeoutsAndRecovery();
}
