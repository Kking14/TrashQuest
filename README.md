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

## Security notes

- Never commit `.env` files or real credentials.
- Use a unique, randomly generated `JWT_SECRET` with at least 32 characters.
- Replace the development bin-display password before deployment.
- Serve the deployed application over HTTPS.
- HTTPS is required for live mobile camera scanning; residents can use the photo or session-code fallback when camera access is unavailable.
- Restrict database network access and use a dedicated MongoDB account with only the permissions TrashQuest requires.

## Repository

Maintained by [Kking14](https://github.com/Kking14).
