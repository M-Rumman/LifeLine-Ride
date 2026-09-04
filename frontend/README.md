# LifeLine Ride — Demo Cockpit

Single-page React + Vite + Tailwind cockpit for the Urdu-first village emergency
response demo. Serves on **port 3000** and proxies every `/api`, `/health` and
`/media` request to the FastAPI backend, so no CORS setup is needed.

The backend port is read from `PORT` in the repo-root `.env` (currently `5050`),
so the proxy follows the backend automatically. Start the backend first.

## Run it

From this `frontend/` directory, exactly two commands:

```bash
npm install
```

```bash
npm run dev
```

Then open <http://localhost:3000>.
