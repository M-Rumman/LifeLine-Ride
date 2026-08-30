---
kind: external_dependency
name: Alibaba Cloud OSS — Encrypted temporary incident media storage
slug: alibaba-cloud-oss
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
- Stores encrypted temporary incident photos and voice recordings associated with emergencies reported through Module 1.
- Media is transient (temporary) and should be deleted after incident closure per data privacy guidance in the spec.

### Client constraints
- Region/data-residency considerations apply since this targets rural Pakistan deployments; confirm endpoint/region configuration matches deployment region.
- Images and health-related voice data must be handled carefully — encrypt at rest and enforce auto-delete policy after incident closure plus N days.