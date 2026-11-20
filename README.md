# SafeWear

A React + TypeScript web application rewritten from the SafeWear Flutter smart safety wearable project.

## Features

- **Authentication**: Email/password sign-up and login with validation, Google sign-in, session persistence, and logout (supports Firebase Auth + Firestore via `VITE_FIREBASE_*` environment variables, with an automatic `localStorage` fallback when unconfigured).
- **Wearable Connection (Web Bluetooth)**: Connects to ESP32-C3 / BLE safety wearables via the Web Bluetooth API, subscribes to GATT notify/indicate characteristics, and decodes incoming UTF-8 JSON payloads (`sos`, `ppg`, `magnetic`, `vibration`, `cancel`).
- **Emergency SOS**: 10-second cancellation countdown upon receiving an SOS press signal, manual cancellation, and automatic geolocation capture on confirmation.
- **Live Sensor Monitoring**: Real-time display for Heart Rate (BPM), Magnetic sensor state (`Normal` / `Detected`), and Vibration Feedback (`Active` / `Inactive`).
- **Location Tracking**: On-demand GPS coordinate fetching via the browser Geolocation API.

## Development

```bash
npm install
npm run dev
```

The development server runs on `http://0.0.0.0:3000`.

## Build & Type Check

```bash
npm run lint
npm run build
```
