# TrashQuest

TrashQuest is a smart three-bin waste station and community rewards platform for barangays. The station is designed to identify plastic bottles, tin cans, and paper, guide residents through a disposal session, and issue one QR code or claim code for the entire session.

The web platform includes interfaces for residents, barangay administrators, and the bin's touchscreen display.

## How it works

1. A resident drops accepted waste into the TrashQuest station.
2. The station identifies the material using its sensors and camera system.
3. All accepted items are grouped into one disposal session.
4. The bin display shows the detected waste and generates one QR code and claim code.
5. The resident scans the QR code or enters the code in the resident portal.
6. Points and eligible daily or weekly quest progress are updated.

The planned station hardware uses an inductive sensor for tin cans, an infrared sensor for plastic bottles, and a camera running a YOLOv8 model. This repository currently contains the TrashQuest web application and API; hardware firmware and model deployment can be integrated separately.

## Main interfaces

- **Resident portal** - register, sign in, claim disposal sessions, track points, complete quests, review history, and redeem rewards.
- **Barangay dashboard** - monitor activity, residents, full-bin alerts, quests, schedules, and rewards.
- **Bin display** - simulate detected waste during development, group items into a session, and present its QR and manual claim code.

## Features

- Separate first name, middle initial, and last name registration fields
- Password confirmation, strength feedback, secure hashing, and JWT authentication
- Session-based QR and manual-code claims
- Plastic bottle, tin can, paper, and weight-based quest targets
- Daily and weekly quests with scheduling and expiration handling
- Completed and expired quest history
- Ultrasonic-sensor full/available bin indicators
- Searchable, sortable, and paginated resident directory
- Barangay activity history grouped by resident
- Reward and bin management modals
- Responsive desktop and mobile layouts
- API security headers, validation, payload limits, and rate limiting

## Technology stack

### Frontend

- React 19
- Vite 6
- QRCode and qr-scanner

### Backend

- Node.js and Express
- MongoDB and Mongoose
- JSON Web Tokens
- bcryptjs
- Helmet and express-rate-limit

## Project structure

```text
TrashQuest/
├── Backend/       Express API, services, models, and authentication
├── Frontend/      React resident, barangay, and bin-display interfaces
└── README.md
```

## Local setup

### Requirements

- Node.js 18 or newer
- npm
- A local or hosted MongoDB database

### 1. Clone the repository

```bash
git clone https://github.com/Kking14/TrashQuest.git
cd TrashQuest
```

### 2. Configure and run the backend

```bash
cd Backend
npm install
```

Create `Backend/.env`:

```env
MONGO_URI=mongodb://127.0.0.1:27017/trashquest
JWT_SECRET=replace-this-with-a-random-secret-of-at-least-32-characters
PORT=5001
```

Start the API:

```bash
npm run dev
```

### 3. Configure and run the frontend

Open another terminal:

```bash
cd Frontend
npm install
npm run dev
```

The development site is available at `http://localhost:5173`. Vite proxies `/api` requests to `http://localhost:5001` by default.

Optional frontend environment variables can be placed in `Frontend/.env`:

```env
VITE_API_BASE_URL=
VITE_BIN_DASHBOARD_PASSWORD=choose-a-station-display-password
```

Leave `VITE_API_BASE_URL` empty during normal local development to use the Vite proxy. For deployment, set it to the public backend URL when the frontend and API are hosted separately.

## Production build

```bash
cd Frontend
npm run build
```

The generated production files are written to `Frontend/dist`.

## Connect the AI model and ESP32

The station uses `station_gateway.py` as the bridge between the ESP32, YOLO,
the Express API, and the React bin display. Do not connect the browser directly
to the serial port.

1. Install the ArduinoJson 7 library in the Arduino IDE and flash the sketch in
   `sketch_jul20aAllsensorsworking_copy_20260812160835/` to the ESP32.
2. Create the bin in the barangay dashboard and copy its device key.
3. Install the station dependencies:

   ```bash
   python -m pip install -r requirements-station.txt
   ```

4. Copy `.env.station.example` to `.env.station`, set `TQ_SERIAL_PORT` and
   `TQ_DEVICE_KEY`, and confirm that `TQ_MODEL_PATH` points to the trained model.
5. Start MongoDB, the backend, and the frontend, then run:

   ```bash
   python station_gateway.py
   ```

6. Open the bin display and save the same device key there. Its status changes
   from **Test mode** to **Hardware connected** when the camera, ESP32, and
   gateway are ready.

The gateway publishes confirmed sorted items at `http://127.0.0.1:8765/events`.
It creates each disposal claim using a stable detection ID, so retrying a failed
HTTP response cannot create duplicate points. The kiosk uses those claim tokens
to create the existing multi-item QR session.

The current hardware has no load cell, so default weights are used for point
estimates (paper 80 g, plastic 45 g, tin can 25 g). Add a calibrated load-cell
reading as `grams` in the ESP32 `object_ready` message when that component is
available.

### Ultrasonic full-bin reporting

The ESP32 sketch supports one HC-SR04 capacity sensor with trigger on GPIO 27
and echo on GPIO 14. Because HC-SR04 echo is 5 V, connect it to the ESP32 through
a voltage divider that reduces the signal to 3.3 V. The sensor should face down
from the top of the container.

The default full threshold is 10 cm (`fullDistanceCm` in the sketch). Three
consecutive readings are required before the state changes. The ESP32 reports
changes immediately and sends a heartbeat every 60 seconds. The gateway updates
the authenticated bin through `/api/bins/sensor/full-status`; the admin dashboard
polls every 10 seconds, marks the bin **Full / Needs collection**, and displays a
notification when it changes from available to full.

### One-click Windows launcher

After completing the configuration above, double-click `start-trashquest.cmd`
from the project folder. It checks the environment and COM port, opens the
backend, frontend, and station gateway in separate terminals, waits for them to
become ready, and opens the website. Use `stop-trashquest.cmd` to stop only the
processes recorded by that launch.

## Security notes

- Never commit `.env` files or real credentials.
- Use a unique, randomly generated `JWT_SECRET` with at least 32 characters.
- Replace the development bin-display password before deployment.
- Serve the deployed application over HTTPS.
- HTTPS is required for live mobile camera scanning; residents can use the photo or session-code fallback when camera access is unavailable.
- Restrict database network access and use a dedicated MongoDB account with only the permissions TrashQuest requires.

## Repository

Maintained by [Kking14](https://github.com/Kking14).
