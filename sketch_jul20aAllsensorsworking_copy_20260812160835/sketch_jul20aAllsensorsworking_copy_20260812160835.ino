#include <ArduinoJson.h>

// TrashQuest ESP32 controller. Install ArduinoJson 7.x in Library Manager.
// Serial is newline-delimited JSON at 115200 baud.

const int sensorPin = 34;       // Sharp GP2Y0A21YK0F: object present
const int inductivePin = 26;    // active-low metal sensor
const int dirPin = 32;
const int pulPin = 33;
const int servoPin = 25;
const int trigPin = 27;         // HC-SR04 trigger
const int echoPin = 14;         // HC-SR04 echo (use a 5V-to-3.3V voltage divider)

const float adcMax = 4095.0;
const float vRef = 3.3;
const int numSamples = 15;
const float minDetectDistance = 2.0;
const float maxDetectDistance = 12.7;
const int consecutiveConfirms = 3;

const int moveSteps = 200;
const int stepDelayUs = 3000;
const int servoSpeedMs = 3;
const int servoNormalAngle = -20;
const int servoDownAngle = 90;
const bool metalDirection = HIGH;
const bool plasticDirection = LOW;
// Allow time for the resident to review the website classification before the
// gateway sends sort/reject. No motor moves while the controller is waiting.
const unsigned long commandTimeoutMs = 120000;
const float fullDistanceCm = 10.0;
const int fullnessConfirms = 3;
const unsigned long fullnessSampleIntervalMs = 1000;
const unsigned long fullnessHeartbeatMs = 60000;

bool waitingForCommand = false;
bool waitForRemoval = false;
int confirmCount = 0;
String activeDetectionId;
unsigned long commandStartedAt = 0;
unsigned long lastFullnessSampleAt = 0;
unsigned long lastFullnessReportAt = 0;
int fullConfirmCount = 0;
int availableConfirmCount = 0;
bool reportedFull = false;
bool hasFullnessReport = false;

void stepMotor(int steps, bool direction);
void moveServoSlowly(int startAngle, int endAngle);
void holdServo(int angle, int cycles);
void runSortingMovement(bool outwardDirection);
void runPaperMovement();
float getMedianDistance();
void updateFullness();

void sendEvent(const char *eventName, const String &detectionId, bool success = true) {
  JsonDocument message;
  message["event"] = eventName;
  if (detectionId.length()) message["detectionId"] = detectionId;
  message["success"] = success;
  serializeJson(message, Serial);
  Serial.println();
}

void sendObjectReady(bool metal, bool objectPresent) {
  activeDetectionId = "esp32-" + String(millis());
  JsonDocument message;
  message["event"] = "object_ready";
  message["detectionId"] = activeDetectionId;
  message["metal"] = metal;
  message["objectPresent"] = objectPresent;
  serializeJson(message, Serial);
  Serial.println();
  waitingForCommand = true;
  commandStartedAt = millis();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  pinMode(sensorPin, INPUT);
  pinMode(inductivePin, INPUT_PULLUP);
  pinMode(dirPin, OUTPUT);
  pinMode(pulPin, OUTPUT);
  pinMode(servoPin, OUTPUT);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  digitalWrite(dirPin, LOW);
  digitalWrite(pulPin, LOW);
  digitalWrite(servoPin, LOW);
  digitalWrite(trigPin, LOW);
  holdServo(servoNormalAngle, 25);
  sendEvent("ready", "");
}

void performSort(const String &wasteType) {
  if (wasteType == "Tin Can") {
    runSortingMovement(metalDirection);
  } else if (wasteType == "Plastic") {
    runSortingMovement(plasticDirection);
  } else if (wasteType == "Paper") {
    runPaperMovement();
  }
}

void runSortingMovement(bool outwardDirection) {
  // Metal and plastic move to opposite sides before the servo gate opens.
  stepMotor(moveSteps, outwardDirection);
  delay(1000);

  moveServoSlowly(servoNormalAngle, servoDownAngle);
  delay(2000);

  moveServoSlowly(servoDownAngle, servoNormalAngle);
  delay(1000);

  stepMotor(moveSteps, !outwardDirection);
}

void runPaperMovement() {
  // Paper uses the home route, so only the servo gate moves.
  moveServoSlowly(servoNormalAngle, servoDownAngle);
  delay(2000);

  moveServoSlowly(servoDownAngle, servoNormalAngle);
}

void handleCommand() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (!line.length()) return;

  JsonDocument command;
  if (deserializeJson(command, line)) return;
  String detectionId = command["detectionId"] | "";
  String action = command["command"] | "";
  String source = command["source"] | "";
  String requestedWasteType = command["wasteType"] | "";

  // Paper may be too thin to trigger the Sharp sensor. Accept a sustained,
  // gateway-authored AI paper event while idle; all other commands still need
  // the matching physical object_ready handshake.
  bool aiPaperStart = !waitingForCommand && !waitForRemoval &&
                      action == "sort" && source == "ai_camera" &&
                      requestedWasteType == "Paper" && detectionId.length();
  if (aiPaperStart) {
    activeDetectionId = detectionId;
    waitingForCommand = true;
  }
  if (!waitingForCommand || detectionId != activeDetectionId) return;

  if (action == "sort") {
    String wasteType = requestedWasteType;
    if (wasteType == "Paper" || wasteType == "Plastic" || wasteType == "Tin Can") {
      performSort(wasteType);
      sendEvent("sorted", activeDetectionId, true);
    } else {
      sendEvent("sorted", activeDetectionId, false);
    }
  } else if (action == "reject") {
    sendEvent("rejected", activeDetectionId, true);
  } else {
    return;
  }
  waitingForCommand = false;
  waitForRemoval = true;
}

void loop() {
  handleCommand();
  updateFullness();

  float distanceCm = getMedianDistance();
  bool objectPresent = distanceCm >= minDetectDistance && distanceCm <= maxDetectDistance;
  bool metal = digitalRead(inductivePin) == LOW;

  if (waitForRemoval) {
    if (!objectPresent && !metal) {
      waitForRemoval = false;
      activeDetectionId = "";
      confirmCount = 0;
      sendEvent("ready", "");
    }
    delay(50);
    return;
  }

  if (waitingForCommand) {
    if (millis() - commandStartedAt > commandTimeoutMs) {
      sendEvent("timeout", activeDetectionId, false);
      waitingForCommand = false;
      waitForRemoval = true;
    }
    delay(20);
    return;
  }

  // Either physical sensor can begin a detection. The gateway fuses the
  // inductive result, Sharp presence, and AI camera classification.
  if (objectPresent || metal) confirmCount++; else confirmCount = 0;
  if (confirmCount >= consecutiveConfirms) {
    confirmCount = 0;
    sendObjectReady(metal, objectPresent);
  }
  delay(50);
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

  unsigned long duration = pulseIn(echoPin, HIGH, 30000);
  if (duration == 0) return;
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

  bool confirmed = fullConfirmCount >= fullnessConfirms ||
                   availableConfirmCount >= fullnessConfirms;
  if (!confirmed) return;

  bool shouldReport = !hasFullnessReport || reportedFull != fullNow ||
                      now - lastFullnessReportAt >= fullnessHeartbeatMs;
  if (!shouldReport) return;

  JsonDocument message;
  message["event"] = "bin_fullness";
  message["isFull"] = fullNow;
  message["distanceCm"] = round(distanceCm * 10.0) / 10.0;
  serializeJson(message, Serial);
  Serial.println();

  reportedFull = fullNow;
  hasFullnessReport = true;
  lastFullnessReportAt = now;
}

void stepMotor(int steps, bool direction) {
  digitalWrite(pulPin, LOW);
  digitalWrite(dirPin, direction);
  delay(100);

  for (int i = 0; i < steps; i++) {
    digitalWrite(pulPin, HIGH);
    delayMicroseconds(stepDelayUs);
    digitalWrite(pulPin, LOW);
    delayMicroseconds(stepDelayUs);
  }

  digitalWrite(pulPin, LOW);
}

void moveServoSlowly(int startAngle, int endAngle) {
  int movementDirection = endAngle > startAngle ? 1 : -1;

  for (int angle = startAngle;
       angle != endAngle + movementDirection;
       angle += movementDirection) {
    holdServo(angle, 1);
    delay(servoSpeedMs);
  }

  holdServo(endAngle, 15);
}

void holdServo(int angle, int cycles) {
  angle = constrain(angle, -20, 180);
  int pulseWidthUs = map(angle, -20, 180, 400, 2400);

  for (int cycle = 0; cycle < cycles; cycle++) {
    digitalWrite(servoPin, HIGH);
    delayMicroseconds(pulseWidthUs);
    digitalWrite(servoPin, LOW);
    delayMicroseconds(20000 - pulseWidthUs);
  }
}

float getMedianDistance() {
  float readings[numSamples];
  for (int i = 0; i < numSamples; i++) {
    int rawValue = analogRead(sensorPin);
    float voltage = (rawValue / adcMax) * vRef;
    readings[i] = voltage < 0.1 ? 100.0 : 27.86 * pow(voltage, -1.15);
    delay(3);
  }
  for (int i = 0; i < numSamples - 1; i++) {
    for (int j = 0; j < numSamples - i - 1; j++) {
      if (readings[j] > readings[j + 1]) {
        float temp = readings[j];
        readings[j] = readings[j + 1];
        readings[j + 1] = temp;
      }
    }
  }
  return readings[numSamples / 2];
}
