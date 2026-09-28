# TrashQuest on Vercel

Keep the camera, ESP32, YOLO model, and `station_gateway.py` on the Raspberry Pi. Deploy the Express API and the resident/admin Vite site as **two Vercel projects** from this repository. The Pi's local Nginx site remains the station display.

## Before deploying

Rotate the MongoDB password and JWT secret previously shared outside the Pi, then update the Pi's `Backend/.env` and the Vercel API environment variables. Do not commit `.env` files or put device keys or database credentials in any `VITE_` variable. The Vercel API must connect to the **same MongoDB database** as the Pi so its existing bins, residents, claims, and device keys remain available.

## 1. Deploy the API

Import `Kking14/TrashQuest` into Vercel and set the project's **Root Directory** to `Backend`. Use the production branch containing these deployment changes. Vercel recognizes `src/server.js` as an Express entry point.

Add these **Production** environment variables to the API project:

| Name | Value |
| --- | --- |
| `MONGO_URI` | MongoDB Atlas URI for the existing TrashQuest database, with the rotated password |
| `JWT_SECRET` | A new random secret of at least 32 characters |
| `FRONTEND_ORIGINS` | The exact HTTPS origin of the frontend project, without a trailing slash; comma-separate additional trusted origins |

Set MongoDB Atlas network access so the Vercel deployment can connect. Review Atlas's network-access options before widening the allowlist. Deploy the API, then open `https://YOUR-API.vercel.app/api/health`. A JSON response with `success: true` confirms the function and database are reachable.

## 2. Deploy the site

Import the **same repository again** as a second Vercel project. Set **Root Directory** to `Frontend`, **Framework Preset** to Vite, **Build Command** to `npm run build`, and **Output Directory** to `dist`.

Add this **Production** environment variable to the frontend project:

| Name | Value |
| --- | --- |
| `VITE_API_BASE_URL` | `https://YOUR-API.vercel.app` without a trailing slash |

Deploy the site. Its `vercel.json` supports direct links to SPA pages. Check the login and a resident claim-code page on the HTTPS frontend URL. On a phone, grant camera permission and test QR scanning. If the frontend URL differs from `FRONTEND_ORIGINS`, update the API variable and redeploy it.

## 3. Point the Pi gateway to the public API

Only after the API and site work, edit `/home/trashquest/TrashQuest-latest/.env.station` on the Pi:

```env
TQ_BACKEND_URL=https://YOUR-API.vercel.app
```

Keep its existing `TQ_DEVICE_KEY`, `TQ_SERIAL_PORT`, and `TQ_MODEL_PATH`. Restart `station_gateway.py`. It should load point rates and submit disposal results to the same database through the deployed API. Continue opening the **station display from the Pi's local Nginx site** (`http://localhost`); the public Vercel site is for resident and admin phones. Test one disposal end to end and confirm its real QR code awards points.

The Pi's local backend and frontend can remain available as a fallback during testing. A Vercel deploy does not change them automatically.
