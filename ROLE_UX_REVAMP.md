# LifeLine Ride — Role-Based Product Revamp

## What changed

LifeLine Ride now treats Reporter, Responder and BHU as separate product experiences rather than three permanent panels on the same primary screen.

### Routes
- `/report` — Reporter
- `/responder` — Responder
- `/bhu` — BHU
- `/operations` — optional judge/operator cockpit

### Product boundary
Normal sessions persist a role in browser storage and are prevented from navigating into another role's route. The backend incident remains shared, so lifecycle changes still propagate between the role-specific views.

### Geography
The Reporter experience is anchored around real mapped localities around Tamman, including Tamman, Dhermond, Multan Khurd, Patwali, Sangwala, Darot, Bedhar, Budhial, Wanhar and Saghar. Additional Talagang localities are represented in the operations catalog. Legacy `VILLAGE-A/B/C` identifiers remain supported for regression compatibility.

### Maps
Role pages use the contextual incident map: only the concerned reporter/responder/BHU and relevant route are shown. `/operations` owns the broader network map containing the seeded villages, BHUs and responders.

### Compatibility
The existing emergency lifecycle, PostgreSQL persistence, demo flow, help-bot behavior, points/verification services and regression-oriented legacy identifiers are intentionally preserved.
