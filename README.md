# VIVELY Dashboard

Dashboard frontend + auth backend in one app, ready for Render.

## What is included

- `index.html`: existing dashboard frontend
- `server.js`: Node.js + Express backend
- `POST /api/signup`: create user
- `POST /api/login`: login user
- `GET /api/health`: health check

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy to Render (frontend + backend together)

### Option A (recommended): Render Blueprint

Repo ini sudah punya file [render.yaml](render.yaml), jadi kamu bisa deploy langsung via Blueprint.

1. Push repo ke GitHub.
2. Di Render, pilih **New +** -> **Blueprint**.
3. Pilih repository ini.
4. Render akan baca `render.yaml` otomatis.
5. Klik **Apply**.

### Option B: Manual Web Service

1. Push this repo to GitHub.
2. In Render, click **New +** -> **Web Service**.
3. Connect your GitHub repository.
4. Use these settings:
	- Runtime: `Node`
	- Build Command: `npm install`
	- Start Command: `npm start`
	- Node version: `>=18`
5. Click **Create Web Service**.

After deploy, your dashboard and API are served from the same domain:

- Frontend: `/`
- Signup API: `/api/signup`
- Login API: `/api/login`

## Important note for production

Current user storage uses local file `data/users.json` (good for demo/dev).
On Render free instances, local files are ephemeral and can reset on redeploy/restart.

For production, move users to a real database (for example: Render Postgres).