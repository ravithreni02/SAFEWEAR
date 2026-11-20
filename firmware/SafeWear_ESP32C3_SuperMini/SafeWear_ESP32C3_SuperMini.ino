#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ===================== BLE CONFIG (Nordic UART Bidirectional) =====================
#define DEVICE_NAME   "SafeWear-ESP32"
#define SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define RX_CHAR_UUID  "6e400002-b5a3-f393-e0a9-e50e24dcca9e" // Write  <- SafeWear App
#define TX_CHAR_UUID  "6e400003-b5a3-f393-e0a9-e50e24dcca9e" // Notify -> SafeWear App

// ===================== BREADBOARD PINOUT (ESP32-C3 SuperMini) =====================
#define PIN_PPG        1   // J16 -> Heart Rate / Pulse Sensor S pin (ADC1_CH1)
#define PIN_SOS_BTN    3   // J14 -> J19 Tactile Push Button (J21 -> GND)
#define PIN_VIBRATION  4   // J13 -> J24 -> 1k Resistor -> BC547 Base (G29)
#define PIN_MAGNETIC   10  // A15 -> A24 Hall Effect Sensor Module DO
#define PIN_LED        8   // Onboard Blue LED (Active LOW)

// ===================== SETTINGS =====================
const unsigned long SOS_CANCEL_WINDOW_MS = 6200; // 6-second cancel window (+200ms margin)
const unsigned long CLICK_COOLDOWN_MS    = 350;  // Prevents Click #1 bounce from triggering Click #2
const bool MAGNET_ACTIVE_LOW = true;             // Set false if Hall DO goes HIGH near magnet
const int ABNORMAL_HIGH_BPM = 120;
const int ABNORMAL_LOW_BPM  = 45;

// ===================== 3 VIBRATION PATTERNS =====================
enum VibPattern {
  VIB_NONE,
  VIB_SOS_STARTED,    // Rapid 300ms pulses during 6s cancel window
  VIB_SOS_CANCELLED,  // 2 quick short taps: 120ms ON, 100ms OFF, 120ms ON
  VIB_SOS_SENT,       // 1 long buzz + 2 short confirmations
  VIB_HR_ALERT        // 2 medium pulses
};

const unsigned long PAT_CANCELLED[] = { 120, 100, 120 };
const int PAT_CANCELLED_LEN = 3;

const unsigned long PAT_SENT[] = { 900, 180, 150, 120, 150 };
const int PAT_SENT_LEN = 5;

const unsigned long PAT_HR_ALERT[] = { 250, 150, 250 };
const int PAT_HR_ALERT_LEN = 3;

VibPattern activePattern = VIB_NONE;
int patternStep = 0;
unsigned long patternStepStartedAt = 0;
bool motorIsOn = false;

// ===================== BLE STATE =====================
BLEServer* pServer = nullptr;
BLECharacteristic* pTxCharacteristic = nullptr;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// ===================== SOS & ROBUST BUTTON STATE =====================
bool sosPending = false;
unsigned long sosStartTime = 0;
bool sentPatternPlayed = false;

bool btnWasReleased = true;
unsigned long btnLowSince = 0;
unsigned long lastClickHandledAt = 0;

// ===================== PENDANT (HALL) STATE =====================
bool lastPendantWorn = false;

// ===================== PPG HEART RATE STATE =====================
float ppgBaseline = 2048.0f;
const int PPG_PEAK_DELTA = 140;
const int PPG_RESET_DELTA = 60;
bool pulseDetected = false;
unsigned long lastBeatTime = 0;
int currentBpm = 0;
unsigned long lastPpgSend = 0;
unsigned long lastHrAlertSend = 0;

unsigned long lastBlinkTime = 0;
bool ledState = false;

// ===================== HELPERS =====================
const char* patternName(VibPattern p) {
  switch (p) {
    case VIB_SOS_STARTED:   return "sos_started";
    case VIB_SOS_CANCELLED: return "sos_cancelled";
    case VIB_SOS_SENT:      return "sos_sent";
    case VIB_HR_ALERT:      return "hr_alert";
    default:                return "idle";
  }
}

void sendJson(const String& payload) {
  if (!deviceConnected || pTxCharacteristic == nullptr) return;
  pTxCharacteristic->setValue(payload.c_str());
  pTxCharacteristic->notify();
  Serial.println("BLE TX -> " + payload);
  delay(20);
}

// Drive motor pin WITHOUT spamming BLE notifications on every 300ms toggle
void driveMotorPin(bool on) {
  digitalWrite(PIN_VIBRATION, on ? HIGH : LOW);
  motorIsOn = on;
}

void startVibrationPattern(VibPattern pat) {
  activePattern = pat;
  patternStep = 0;
  patternStepStartedAt = millis();

  if (pat == VIB_NONE) {
    driveMotorPin(false);
    sendJson("{\"type\":\"vibration\",\"state\":\"off\",\"pattern\":\"idle\"}");
  } else {
    driveMotorPin(true);
    // Notify app ONCE at start of pattern (keeps BLE queue free for instant cancel!)
    sendJson(String("{\"type\":\"vibration\",\"state\":\"on\",\"pattern\":\"") +
             patternName(pat) + "\"}");
  }
}

void updateVibrationEngine(unsigned long now) {
  if (activePattern == VIB_NONE) return;

  // Continuous pulsing during 6-second SOS countdown (hardware pin only, no BLE spam)
  if (activePattern == VIB_SOS_STARTED) {
    if (now - patternStepStartedAt >= 300) {
      patternStepStartedAt = now;
      driveMotorPin(!motorIsOn);
    }
    return;
  }

  const unsigned long* steps = nullptr;
  int stepCount = 0;
  if (activePattern == VIB_SOS_CANCELLED) { steps = PAT_CANCELLED; stepCount = PAT_CANCELLED_LEN; }
  else if (activePattern == VIB_SOS_SENT) { steps = PAT_SENT; stepCount = PAT_SENT_LEN; }
  else if (activePattern == VIB_HR_ALERT) { steps = PAT_HR_ALERT; stepCount = PAT_HR_ALERT_LEN; }

  if (steps != nullptr && (now - patternStepStartedAt >= steps[patternStep])) {
    patternStep++;
    patternStepStartedAt = now;
    if (patternStep >= stepCount) {
      activePattern = VIB_NONE;
      driveMotorPin(false);
      sendJson("{\"type\":\"vibration\",\"state\":\"off\",\"pattern\":\"idle\"}");
    } else {
      driveMotorPin(patternStep % 2 == 0);
    }
  }
}

bool isPendantWorn() {
  int val = digitalRead(PIN_MAGNETIC);
  return MAGNET_ACTIVE_LOW ? (val == LOW) : (val == HIGH);
}

// ===================== BLE CALLBACKS =====================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    deviceConnected = true;
    digitalWrite(PIN_LED, LOW); // Solid ON
    Serial.println("SafeWear app connected!");
  }

  void onDisconnect(BLEServer* server) override {
    deviceConnected = false;
    Serial.println("SafeWear app disconnected.");
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    String rx = pCharacteristic->getValue().c_str();
    if (rx.length() == 0) return;
    Serial.println("BLE RX <- " + rx);

    if (rx.indexOf("sos_sent") >= 0) {
      sosPending = false;
      if (!sentPatternPlayed) {
        sentPatternPlayed = true;
        startVibrationPattern(VIB_SOS_SENT);
      }
    } else if (rx.indexOf("sos_cancelled") >= 0) {
      sosPending = false;
      sentPatternPlayed = false;
      startVibrationPattern(VIB_SOS_CANCELLED);
    }
  }
};

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);
  delay(600);

  pinMode(PIN_SOS_BTN, INPUT_PULLUP);
  pinMode(PIN_MAGNETIC, INPUT_PULLUP);
  pinMode(PIN_VIBRATION, OUTPUT);
  pinMode(PIN_LED, OUTPUT);

  digitalWrite(PIN_VIBRATION, LOW);
  digitalWrite(PIN_LED, HIGH);

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_PPG, ADC_11db);
  ppgBaseline = analogRead(PIN_PPG);

  // Brief startup buzz (150ms) to confirm BC547 + motor wiring
  digitalWrite(PIN_VIBRATION, HIGH);
  delay(150);
  digitalWrite(PIN_VIBRATION, LOW);

  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(185);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(
    TX_CHAR_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
    RX_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  pRxCharacteristic->setCallbacks(new RxCallbacks());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();

  Serial.println("SafeWear ESP32-C3 SuperMini Ready (Reliable 2nd-Click Cancel).");
}

// ===================== LOOP =====================
void loop() {
  unsigned long now = millis();
  updateVibrationEngine(now);

  // 1. BLE Reconnect & Initial Sync
  if (!deviceConnected && oldDeviceConnected) {
    delay(300);
    pServer->startAdvertising();
    oldDeviceConnected = false;
  }

  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = true;
    delay(400);
    lastPendantWorn = isPendantWorn();
    sendJson(String("{\"type\":\"magnetic\",\"state\":\"") +
             (lastPendantWorn ? "detected" : "removed") + "\"}");
    sendJson("{\"type\":\"vibration\",\"state\":\"off\",\"pattern\":\"idle\"}");
    sendJson("{\"type\":\"ppg\",\"bpm\":" + String(currentBpm) + "}");
  }

  if (!deviceConnected && (now - lastBlinkTime >= 500)) {
    lastBlinkTime = now;
    ledState = !ledState;
    digitalWrite(PIN_LED, ledState ? LOW : HIGH);
  }

  // 2. Robust Tactile Button Click Detection (GPIO 3)
  //    - Immune to breadboard motor vibration noise
  //    - Click #1 -> Start 6-second SOS countdown + rapid pulses
  //    - Click #2 within 6s -> Immediately cancel SOS (sent twice for 100% BLE delivery)
  bool isPressedNow = (digitalRead(PIN_SOS_BTN) == LOW);

  if (!isPressedNow) {
    btnLowSince = 0;
    btnWasReleased = true;
  } else {
    if (btnLowSince == 0) {
      btnLowSince = now;
    }

    // Trigger once button is cleanly held LOW for 25ms after a release + cooldown
    if (btnWasReleased &&
        (now - btnLowSince >= 25) &&
        (now - lastClickHandledAt >= CLICK_COOLDOWN_MS)) {
      btnWasReleased = false;
      lastClickHandledAt = now;

      if (!sosPending) {
        // CLICK #1: Activate SOS & start 6-second cancel window
        sosPending = true;
        sentPatternPlayed = false;
        sosStartTime = now;

        Serial.println("CLICK #1 -> SOS ACTIVATED (6s cancel window)");
        sendJson("{\"type\":\"sos\",\"value\":\"pressed\"}");
        startVibrationPattern(VIB_SOS_STARTED);
      } else {
        // CLICK #2 WITHIN 6 SECONDS: Cancel SOS immediately!
        sosPending = false;
        sentPatternPlayed = false;

        Serial.println("CLICK #2 -> SOS CANCELLED!");
        // Send cancel packet twice (80ms apart) so BLE never misses it
        sendJson("{\"type\":\"cancel\"}");
        delay(60);
        sendJson("{\"type\":\"cancel\"}");
        startVibrationPattern(VIB_SOS_CANCELLED);
      }
    }
  }

  // 3. When 6 seconds expire without Click #2 -> play "SOS Sent" pattern
  if (sosPending && (now - sosStartTime >= SOS_CANCEL_WINDOW_MS)) {
    sosPending = false;
    if (!sentPatternPlayed) {
      sentPatternPlayed = true;
      Serial.println("6s elapsed -> SOS SENT pattern");
      startVibrationPattern(VIB_SOS_SENT);
    }
  }

  // 4. Hall Effect Sensor (GPIO 10) -> Pendant Worn / Not Worn
  bool wornNow = isPendantWorn();
  if (wornNow != lastPendantWorn) {
    lastPendantWorn = wornNow;
    sendJson(String("{\"type\":\"magnetic\",\"state\":\"") +
             (wornNow ? "detected" : "removed") + "\"}");
  }

  // 5. Heart Rate Sensor (GPIO 1) -> Live BPM + Abnormal Alert
  //    Skip BLE PPG broadcast while SOS 6s countdown is active so cancel packet has priority
  int ppgRaw = analogRead(PIN_PPG);
  ppgBaseline = (ppgBaseline * 0.95f) + (ppgRaw * 0.05f);
  float delta = ppgRaw - ppgBaseline;

  if (delta > PPG_PEAK_DELTA && !pulseDetected) {
    pulseDetected = true;
    if (lastBeatTime > 0) {
      unsigned long ibi = now - lastBeatTime;
      if (ibi >= 280 && ibi <= 1600) {
        int bpm = (int)(60000UL / ibi);
        currentBpm = (currentBpm == 0) ? bpm : ((currentBpm * 3 + bpm) / 4);
      }
    }
    lastBeatTime = now;
  } else if (delta < PPG_RESET_DELTA) {
    pulseDetected = false;
  }

  if (lastBeatTime > 0 && (now - lastBeatTime > 5000)) {
    currentBpm = 0;
  }

  if (!sosPending && (now - lastPpgSend >= 2000)) {
    lastPpgSend = now;
    sendJson("{\"type\":\"ppg\",\"bpm\":" + String(currentBpm) + "}");

    bool isHigh = (currentBpm >= ABNORMAL_HIGH_BPM);
    bool isLow  = (currentBpm > 0 && currentBpm <= ABNORMAL_LOW_BPM);
    if ((isHigh || isLow) && (now - lastHrAlertSend >= 8000)) {
      lastHrAlertSend = now;
      sendJson("{\"type\":\"hr_alert\",\"bpm\":" + String(currentBpm) +
               ",\"reason\":\"" + String(isHigh ? "high" : "low") + "\"}");
      if (activePattern == VIB_NONE) {
        startVibrationPattern(VIB_HR_ALERT);
      }
    }
  }

  delay(5);
}
