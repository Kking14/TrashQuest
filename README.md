# TrashQuest

TrashQuest is a smart three-bin waste station and community rewards platform for barangays. The station is designed to identify plastic bottles, tin cans, and paper, guide residents through a disposal session, and issue one QR code or claim code for the entire session.

The web platform includes interfaces for residents, barangay administrators, and the bin's touchscreen display.

## How it works

1. A resident places one waste type on the platform (plastic bottles should be crushed first).
2. YOLO filters individual boxes to the configured platform ROI and stabilizes their type and count.
3. The resident confirms the detected batch and the ESP32 performs one sorting movement.
4. Only a matching successful `sorted` acknowledgement creates a claim and its QR/session code.
5. The resident scans the QR code or enters the code in the resident portal.
6. Points and eligible daily or weekly quest progress are updated.

The station uses a camera running the existing YOLO model for explicit waste classification and per-box counting, an inductive sensor for tin-can confirmation, and an ultrasonic sensor dedicated to bin fullness.

## Main interfaces

- **Resident portal** - register, sign in, claim disposal sessions, track points, complete quests, review history, and redeem rewards.
- **Barangay dashboard** - monitor activity, residents, full-bin alerts, quests, schedules, and rewards.
- **Bin display** - simulate detected waste during development, group items into a session, and present its QR and manual claim code.

## Features

- Separate first name, middle initial, and last name registration fields
- Password confirmation, strength feedback, secure hashing, and JWT authentication
- Session-based QR and manual-code claims
- AI-counted plastic bottle, tin can, and paper batches with item-count quest targets
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

Plastic is explicitly recognized by a configured YOLO class. The Sharp sensor
is no longer a classification authority. The GPIO 26 inductive sensor directly
classifies a single Tin Can without requiring an AI detection, while the
ultrasonic sensor is dedicated to fullness.
After a Tin Can is sorted, GPIO 26 must remain inactive for 350 ms; the ESP32
then reports the platform empty and enables the kiosk's next-batch button.
Rewards and quest progress use stabilized AI bounding-box counts. Optional
estimated grams are informational metadata only and never determine points.

### Camera and reward configuration

Copy `.env.station.example` to the untracked `.env.station` file. Calibrate
`TQ_PLATFORM_ROI` as normalized `x1,y1,x2,y2` coordinates around only the
physical platform, verify the model's exact class labels in
`TQ_YOLO_CLASS_MAP`, and tune confidence/stability/rearm time for the installed
camera. Hands, people, background boxes, low-confidence boxes, and boxes whose
centres are outside the ROI are ignored. Stable batches containing more than
one accepted waste type are rejected.

Copy `Backend/.env.example` to the untracked `Backend/.env`. The
`TQ_POINTS_PER_ITEM_*` defaults are configurable placeholders, not approved
barangay values. Configure them only in `Backend/.env`; the authenticated
gateway loads that authoritative rate table from the backend.

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

The controller uses bounded ultrasonic reads and a non-blocking state machine.
A confirmed full bin rejects new reservations while continuing serial health
and fullness reports.

### Simulation and tests

Run the complete gateway/kiosk transaction without a camera or ESP32:

```bash
python station_gateway.py --simulate
```

Open the bin display and use its enabled simulation controls. Simulation stays
offline from the real claim API by default, even when a device key exists, and
produces a clearly marked test QR that cannot award points. Only set
`TQ_SIMULATION_USE_BACKEND=true` when intentionally testing against a disposable
backend. Use **Finish & reset station** to simulate an empty platform and rearm
the next batch.

Run automated checks with:

```bash
python -m unittest discover -s tests
cd Backend && npm test
cd ../Frontend && npm run build
```

Software simulation does not verify motor direction, torque, sensor voltage
levels, camera mounting, ROI calibration, or detection accuracy on physical
waste.

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
