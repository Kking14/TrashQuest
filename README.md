# TrashQuest

TrashQuest is a smart three-bin waste station and community rewards platform for barangays. The station is designed to identify plastic bottles, tin cans, and paper, guide residents through a disposal session, and issue one QR code or claim code for the entire session.

The web platform includes interfaces for residents, barangay administrators, and the bin's touchscreen display.

## How it works

1. A resident places one waste type on the platform (plastic bottles should be crushed first).
2. YOLO identifies paper and plastic bottles inside the platform ROI; the inductive sensor identifies tin cans.
3. The ESP32 automatically sorts the detected item without resident confirmation. Each successful cycle adds the stable AI batch count to the session; inductive tin cans count one at a time.
4. Only a matching successful `sorted` acknowledgement creates a claim and its QR/session code.
5. The resident scans the QR code or enters the code in the resident portal.
6. Points and eligible daily or weekly quest progress are updated.

The station uses a camera running the existing YOLO model for explicit waste classification and waste-type classification, an inductive sensor for tin-can detection, and an ultrasonic sensor dedicated to bin fullness.

## Main interfaces

- **Resident portal** - register, sign in, claim disposal sessions, track points, complete quests, review history, and redeem rewards.
- **Barangay dashboard** - monitor activity, residents, full-bin alerts, quests, schedules, and rewards.
- **Bin display** - simulate detected waste during development, group items into a session, and present its QR and manual claim code.

## Features

- Separate first name, middle initial, and last name registration fields
- Password confirmation, strength feedback, secure hashing, and JWT authentication
- Session-based QR and manual-code claims
- Sequential plastic bottle, tin can, and paper disposals with item-count quest targets
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

To compare models on the running station, open **AI camera** in the bin display,
choose a model under **Detection model**, and press **Use model**. The station
switches only while idle with an empty platform. It loads and warms the new
model before replacing the active one; if loading fails, the previous model
remains active. The menu includes the configured PyTorch model, the bundled
YOLOv8s ONNX/NCNN exports, and the YOLO26n PyTorch/ONNX/NCNN exports. The
selected model lasts until the gateway restarts, when it returns to
`TQ_MODEL_PATH`. Watch **AI FPS** in the
camera panel and test the same objects under each model.

The gateway publishes confirmed sorted items at `http://127.0.0.1:8765/events`.
It creates each disposal claim using a stable detection ID, so retrying a failed
HTTP response cannot create duplicate points. The kiosk uses those claim tokens
to create the existing multi-item QR session.

Mixed paper/plastic detections, or inductive metal together with camera waste,
show a one-waste-type notice and block sorting until both sensors remain clear.
Metal batches wait for a fresh camera frame before sorting. Upload the updated
ESP32 sketch and restart the gateway to enable continuous inductive-state reports
and the firmware guard against metal during a paper/plastic sort. A conflict
detected after motion starts requests a stop; it cannot undo completed motion.

Plastic is explicitly recognized by a configured YOLO class. The Sharp sensor
is no longer a classification authority. The GPIO 26 inductive sensor directly
classifies a single Tin Can without requiring an AI detection, while the
ultrasonic sensor is dedicated to fullness.
After a Tin Can is sorted, GPIO 26 must remain inactive for 350 ms; the ESP32
then reports the platform empty and enables the kiosk's next-batch button.
Rewards and quest progress use the number of successfully sorted items in the resident session. Optional
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
`TQ_POINTS_PER_ITEM_*` defaults are Paper = 5, Plastic = 10, and Tin Can = 15 points. Configure overrides only in `Backend/.env`; the authenticated
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

### Sequential disposal flow

Place one waste type on the platform at a time. Paper and plastic bottles are
counted from separate visible AI boxes. Tin cans use the inductive sensor and
count one at a time. The station identifies and sorts the batch
without a confirmation button, then asks **Are you done throwing waste?**
Choose **Not done** after the platform clears to add another item to the same
session. Choose **Done** to generate one QR and session code for all sorted
items. Two papers in one batch plus one paper in the next batch show three
papers and earn 15 points. Two papers earn 10 points; one paper, one plastic bottle, and one tin can
earn 30 points. Failed motor operations do not add items or award points.
The station pauses acceptance while the done question or QR is displayed.

The ESP32 serial port defaults to **COM3** in `.env.station.example` and the
gateway. The existing firmware prepare/sort protocol supports automatic sorting
without a firmware upload. This checkout does not include the trained `best.pt`
model or live `.env` files; supply the model and configure `.env.station` and
`Backend/.env` before running the physical station. Old reward overrides in
`Backend/.env` must be updated to 5/10/15 to match these defaults.

### Independent camera preview

Camera capture and MJPEG preview run separately from AI inference. The AI uses
only the latest captured frame, preventing a backlog when inference is slower.
`TQ_PREVIEW_FPS=20` sets the preview target; achieved FPS depends on the camera
and computer. The display reports preview FPS and AI FPS separately. Detection
boxes update at AI speed and disappear when older than one second. Counting,
classification thresholds, and sorting still depend on AI results.

## Metal association and two bin sensors

The inductive sensor identifies metal. The gateway matches one AI box covering the sensor and labels that object "Metal detected via inductive sensor". Additional visible objects still block sorting; ambiguous matches also block. The match is held through the active metal transaction using box overlap. This does not retrain the model or guarantee detection of hidden/overlapping objects.

Set `TQ_INDUCTIVE_ROI=0.53,0.41,0.59,0.49` in `.env.station` if calibration is needed (this is also the default). Coordinates are normalized against the full camera frame, not the platform ROI. The purple METAL SENSOR rectangle should surround the blue sensor. Recalibrate if the camera moves. Let the camera run before placing one can over the sensor. Confirm the overlay, then test a can beside paper/plastic: sorting must stay blocked.

| Compartment | TRIG | ECHO | Full threshold |
| --- | --- | --- | --- |
| Plastic | GPIO 27 | GPIO 14 | 10 cm |
| Metal | GPIO 16 | GPIO 34 | 10 cm |

Each ECHO requires its own voltage divider and all sensors share ground. Thresholds are separate firmware constants (`plasticFullDistanceCm`, `metalFullDistanceCm`). Sensors alternate every 500 ms, require three confirming readings, and defer measurement while the stepper is moving. Reports include `binType`, `isFull`, `readingValid`, and `distanceCm`, with a heartbeat every 10 seconds.

Either confirmed full compartment blocks the whole station. Admin Overview and Bins show Plastic and Metal separately and name the full compartment. Missing, invalid, or over-30-second-old readings display as unavailable. A timeout never clears a previously confirmed full state; a valid empty reading must clear it. Ultrasonic distance describes clearance below the sensor, not a calibrated percentage.

After installing these changes, restart backend, frontend, and gateway and upload the updated ESP32 sketch. Check each sensor independently: fill metal while plastic stays empty, then reverse, and unplug one sensor to check unavailable reporting. No model retraining or dependency installation is required by this change.
