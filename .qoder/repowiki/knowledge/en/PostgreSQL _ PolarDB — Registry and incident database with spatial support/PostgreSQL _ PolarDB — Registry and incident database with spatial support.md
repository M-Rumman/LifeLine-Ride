---
kind: external_dependency
name: PostgreSQL / PolarDB — Registry and incident database with spatial support
slug: postgresql-polardb
source: user
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
source_files:
    - PROJECT.md
---

### Role in this project
- Central store for responder registry, BHU records, village↔BHU mappings, and full incident lifecycle logs (Module 5 & 6).
- SQLAlchemy-managed tables (backend/database.py, DATABASE_URL in .env, pool_pre_ping): `incidents` (Module 6.5 persistence), plus Module 5's `responders` (points_total, reliability_tier, availability) and `point_transactions` (award ledger; UNIQUE(incident_id) makes double-awarding structurally impossible). All timestamps are ISO strings, not native DateTime columns.
- Must support spatial lookups for nearest-responder matching (Module 3) using GPS coordinates.

### Client constraints
- PolarDB is the managed variant; ensure spatial extensions/functions are enabled for proximity queries.
- Incident records carry sensitive health data — access controls and encryption at rest are required.