---
kind: external_dependency
name: PostgreSQL / PolarDB — Registry and incident database with spatial support
slug: postgresql-polardb
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
- Must support spatial lookups for nearest-responder matching (Module 3) using GPS coordinates.

### Client constraints
- PolarDB is the managed variant; ensure spatial extensions/functions are enabled for proximity queries.
- Incident records carry sensitive health data — access controls and encryption at rest are required.