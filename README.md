# LifeLine Ride

LifeLine Ride is an Urdu-first rural emergency response platform connecting people in villages with verified local responders and nearby health facilities.

## Product surfaces

- `/` — role selection / public landing
- `/report` — Reporter experience: report, triage, track and close an emergency
- `/responder` — Responder experience: availability, dispatch, navigation and response completion
- `/bhu` — BHU experience: incoming cases, live incident monitoring, verification and closure
- `/operations` — judge/operator view with the synchronized network cockpit and network map

Normal users remain inside their assigned role. Reporter, Responder and BHU state is shared through the authoritative backend incident lifecycle; the Operations view is the only place intended to observe all three perspectives together.

## Geography

The pilot geography is centered on Tamman / Talagang. The Reporter selector uses real mapped localities around Tamman, while the Operations map shows the broader seeded pilot network. Facility points are explicitly treated as approximate where only locality coordinates are available.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

## Backend

See `backend/requirements.txt` and the module/API documentation for the Python environment and FastAPI startup instructions.

## Documentation

The repository contains the original system specification, module reports, API notes and demo scripts. Treat those documents as the source of truth for supported functionality and lifecycle behavior.
