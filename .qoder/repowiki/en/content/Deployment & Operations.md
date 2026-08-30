# Deployment & Operations

<cite>
**Referenced Files in This Document**
- [PROJECT.md](file://PROJECT.md)
- [village-emergency-response-system-spec.md](file://village-emergency-response-system-spec.md)
- [backend/requirements.txt](file://backend/requirements.txt)
- [backend/slice_runner.py](file://backend/slice_runner.py)
- [backend/help_bot_runner.py](file://backend/help_bot_runner.py)
- [backend/services/help_bot_service.py](file://backend/services/help_bot_service.py)
- [backend/services/help_bot_content.py](file://backend/services/help_bot_content.py)
</cite>

## Table of Contents
1. Introduction
2. Project Structure
3. Core Components
4. Architecture Overview
5. Detailed Component Analysis
6. Dependency Analysis
7. Performance Considerations
8. Troubleshooting Guide
9. Conclusion
10. Appendices

## Introduction
This document provides production-oriented deployment and operations guidance for the LifeLine Ride system. It focuses on infrastructure requirements, database setup with spatial lookup support, encrypted temporary media storage, deployment topology options, scaling for concurrent emergency requests, monitoring strategies, log management, backup and recovery, disaster recovery planning, security (API keys, encryption at rest/in transit, access control), troubleshooting, performance tuning, and maintenance procedures.

The system is designed as a Python-based backend that integrates AI services for speech-to-text, vision triage, and text-to-speech, with a responder help bot that guides first responders via Urdu voice. The project spec defines modules for registration and triage, matching/dispatch, escalation, logging, and follow-up notifications.

**Section sources**
- [PROJECT.md:1-20](file://PROJECT.md#L1-L20)
- [village-emergency-response-system-spec.md:11-137](file://village-emergency-response-system-spec.md#L11-L137)

## Project Structure
At runtime, the backend exposes the core pipeline through slice_runner and the help-bot session engine. The help bot runner orchestrates simulation or live modes and can prewarm TTS caches to reduce quota usage. Content for scripted guidance is centralized and provider-agnostic.

```mermaid
graph TB
A["help_bot_runner.py"] --> B["slice_runner.py"]
A --> C["services/help_bot_service.py"]
C --> D["services/help_bot_content.py"]
B --> E["External AI APIs<br/>Gemini / DashScope"]
B --> F["Local Cache<br/>mockdata/media/.triage_cache"]
C --> G["TTS Cache<br/>mockdata/helpbot/tts_cache"]
```

**Diagram sources**
- [backend/help_bot_runner.py:1-241](file://backend/help_bot_runner.py#L1-L241)
- [backend/slice_runner.py:1-745](file://backend/slice_runner.py#L1-L745)
- [backend/services/help_bot_service.py:1-960](file://backend/services/help_bot_service.py#L1-L960)
- [backend/services/help_bot_content.py:1-255](file://backend/services/help_bot_content.py#L1-L255)

**Section sources**
- [backend/help_bot_runner.py:1-241](file://backend/help_bot_runner.py#L1-L241)
- [backend/slice_runner.py:1-745](file://backend/slice_runner.py#L1-L745)
- [backend/services/help_bot_service.py:1-960](file://backend/services/help_bot_service.py#L1-L960)
- [backend/services/help_bot_content.py:1-255](file://backend/services/help_bot_content.py#L1-L255)

## Core Components
- Triage pipeline: STT, vision classification, and severity-tier classifier with provider abstraction (Gemini/DashScope), retry/backoff, and fail-safe behavior.
- Matching and dispatch: Responder availability checks, BHU linkage by village, ambulance request for critical tier.
- Help bot: Hardcoded reactive flow with Urdu content, intent detection, TTS caching, barge-in, and escalation hook.
- Logging and state: In-memory incident store for demo; designed to integrate with persistent storage for production.

Operational implications:
- External API dependencies require robust retries, timeouts, and graceful degradation.
- Local caches reduce quota consumption and improve determinism for testing.
- Escalation hooks must be wired to external dispatch systems in production.

**Section sources**
- [backend/slice_runner.py:305-586](file://backend/slice_runner.py#L305-L586)
- [backend/slice_runner.py:589-672](file://backend/slice_runner.py#L589-L672)
- [backend/services/help_bot_service.py:120-389](file://backend/services/help_bot_service.py#L120-L389)
- [backend/services/help_bot_service.py:572-657](file://backend/services/help_bot_service.py#L572-L657)

## Architecture Overview
The production architecture should separate compute, storage, and AI service integrations. The current codebase uses local file caches and in-memory stores; production should replace these with managed services.

```mermaid
graph TB
subgraph "Compute"
API["API Server<br/>Python Backend"]
BOT["Help Bot Engine"]
end
subgraph "Storage"
DB["PostgreSQL / PolarDB<br/>Spatial Indexes"]
OSS["Encrypted Object Store<br/>Temporary Media"]
LOGS["Logs & Metrics"]
end
subgraph "AI Services"
STT["Speech-to-Text"]
VISION["Vision Triage"]
CLASSIFIER["Severity Classifier"]
TTS["Text-to-Speech"]
end
API --> STT
API --> VISION
API --> CLASSIFIER
BOT --> TTS
API --> DB
API --> OSS
API --> LOGS
BOT --> LOGS
```

[No sources needed since this diagram shows conceptual architecture, not actual code structure]

## Detailed Component Analysis

### Triage Pipeline and Provider Abstraction
- Provider selection is environment-driven; calls are wrapped with timeouts and retries for rate limits.
- Fail-safe defaults ensure emergency flows continue even when AI components degrade.
- Local cache avoids repeated AI calls for identical media inputs.

```mermaid
sequenceDiagram
participant Client as "Client"
participant API as "Backend API"
participant STT as "STT Service"
participant Vision as "Vision Service"
participant Class as "Classifier"
participant Store as "Incident Store"
Client->>API : Submit photo + voice note
API->>STT : Transcribe audio
STT-->>API : Transcript or failure
API->>Vision : Classify injury image
Vision-->>API : Classification JSON
API->>Class : Combine transcript + vision
Class-->>API : Severity tier + flags
API->>Store : Persist incident record
API-->>Client : Dispatch result
```

**Diagram sources**
- [backend/slice_runner.py:367-586](file://backend/slice_runner.py#L367-L586)
- [backend/slice_runner.py:589-672](file://backend/slice_runner.py#L589-L672)

**Section sources**
- [backend/slice_runner.py:55-95](file://backend/slice_runner.py#L55-L95)
- [backend/slice_runner.py:97-129](file://backend/slice_runner.py#L97-L129)
- [backend/slice_runner.py:367-586](file://backend/slice_runner.py#L367-L586)
- [backend/slice_runner.py:589-672](file://backend/slice_runner.py#L589-L672)

### Responder Help Bot Session
- Hardcoded Urdu guidance ensures safety and compliance; AI only handles STT and intent routing.
- TTS output is cached to disk to avoid quota exhaustion and enable deterministic replay.
- Escalation hook upgrades severity, flags BHU notification and ambulance request, and logs transitions.

```mermaid
flowchart TD
Start(["Session Start"]) --> Route["Route Branch by Injury Flags"]
Route --> SpeakInitial["Speak Initial Guidance"]
SpeakInitial --> Listen["Capture & Transcribe Input"]
Listen --> Intent{"Intent Detected?"}
Intent --> |Step Done| NextStep["Advance Step"]
Intent --> |In Scope| Answer["Speak Scripted Answer"]
Intent --> |Escalation| Escalate["Escalate Incident"]
Intent --> |Out of Scope| Fallback["Speak Honest Fallback"]
Intent --> |Unclear| Failsafe["Speak Failsafe Line"]
NextStep --> Listen
Answer --> Listen
Escalate --> MonitorEsc["Monitor in Escalated State"]
Fallback --> Listen
Failsafe --> Listen
MonitorEsc --> End(["Session Finalized"])
```

**Diagram sources**
- [backend/services/help_bot_service.py:663-800](file://backend/services/help_bot_service.py#L663-L800)
- [backend/services/help_bot_service.py:572-657](file://backend/services/help_bot_service.py#L572-L657)
- [backend/services/help_bot_content.py:21-43](file://backend/services/help_bot_content.py#L21-L43)

**Section sources**
- [backend/services/help_bot_service.py:120-389](file://backend/services/help_bot_service.py#L120-L389)
- [backend/services/help_bot_service.py:572-657](file://backend/services/help_bot_service.py#L572-L657)
- [backend/services/help_bot_content.py:21-43](file://backend/services/help_bot_content.py#L21-L43)

### Matching and Dispatch Logic
- Matches nearest available responder per village and links to BHU based on predefined associations.
- For moderate/critical tiers, BHU is notified; for critical, ambulance is requested immediately.
- In production, this logic should query a spatially indexed database and enforce concurrency controls to prevent double assignment.

```mermaid
sequenceDiagram
participant API as "Backend API"
participant Match as "Matching Service"
participant DB as "Responder/BHU DB"
participant Dispatch as "Dispatch Service"
API->>Match : Find available responder by village
Match->>DB : Query responders (spatial + availability)
DB-->>Match : Responder(s)
Match-->>API : Selected responder + linked BHU
API->>Dispatch : Dispatch with severity tier
Dispatch->>DB : Mark responder busy, set timestamps
Dispatch-->>API : Status (dispatched / escalated_bhu_only / no_responders_available)
```

**Diagram sources**
- [backend/slice_runner.py:612-662](file://backend/slice_runner.py#L612-L662)

**Section sources**
- [backend/slice_runner.py:612-662](file://backend/slice_runner.py#L612-L662)

## Dependency Analysis
- External AI providers: Gemini and DashScope SDKs are used conditionally; environment variables select endpoints and models.
- Audio stack: sounddevice/soundfile are optional and best-effort; playback/capture failures do not block the session.
- Local caches: Triage results and TTS audio are cached under mockdata paths for development/demo; production should move to managed storage.

```mermaid
graph LR
Env[".env Variables"] --> SR["slice_runner.py"]
SR --> STT["gemini_transcribe_voice / dashscope_transcribe_voice"]
SR --> VIS["gemini_classify_injury / dashscope_classify_injury"]
SR --> CLS["gemini_combine_signals / dashscope_combine_signals"]
HBS["help_bot_service.py"] --> TTS["gemini_synthesize_speech / dashscope_synthesize_speech"]
HBR["help_bot_runner.py"] --> HBS
```

**Diagram sources**
- [backend/slice_runner.py:11-69](file://backend/slice_runner.py#L11-L69)
- [backend/slice_runner.py:367-506](file://backend/slice_runner.py#L367-L506)
- [backend/services/help_bot_service.py:295-389](file://backend/services/help_bot_service.py#L295-L389)
- [backend/help_bot_runner.py:102-133](file://backend/help_bot_runner.py#L102-L133)

**Section sources**
- [backend/requirements.txt:1-6](file://backend/requirements.txt#L1-L6)
- [backend/slice_runner.py:11-69](file://backend/slice_runner.py#L11-L69)
- [backend/services/help_bot_service.py:295-389](file://backend/services/help_bot_service.py#L295-L389)
- [backend/help_bot_runner.py:102-133](file://backend/help_bot_runner.py#L102-L133)

## Performance Considerations
- Timeouts and retries: Configure per-call timeouts and bounded retries for AI services to protect latency during quota spikes.
- Caching strategy: Pre-warm TTS cache and leverage triage result cache to minimize AI calls and stabilize response times.
- Concurrency: Use connection pooling for databases and object storage; implement worker pools for STT/vision/classifier calls.
- Spatial queries: Ensure PostgreSQL/PolarDB has appropriate indexes (e.g., PostGIS) for fast nearest-responder lookups.
- Media handling: Stream large audio/video to object storage; process chunks to reduce memory pressure.
- Monitoring: Track latency percentiles, error rates, quota utilization, and cache hit ratios.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common operational issues and resolutions:
- Missing API keys: Ensure .env contains required keys for AI providers; the code raises explicit errors if missing.
- Quota exhaustion: Use retries with backoff; pre-warm TTS cache; monitor quotas and adjust model choices.
- Audio device unavailable: Playback/capture are best-effort; sessions continue without hardware.
- Non-JSON model responses: Robust parsing tolerates markdown fences; still log failures and fall back safely.
- No responders available: Escalation path triggers BHU-only dispatch; verify village-BHU mappings and responder availability.

**Section sources**
- [backend/slice_runner.py:36-52](file://backend/slice_runner.py#L36-L52)
- [backend/slice_runner.py:72-95](file://backend/slice_runner.py#L72-L95)
- [backend/slice_runner.py:349-364](file://backend/slice_runner.py#L349-L364)
- [backend/services/help_bot_service.py:394-403](file://backend/services/help_bot_service.py#L394-L403)
- [backend/slice_runner.py:612-662](file://backend/slice_runner.py#L612-L662)

## Conclusion
LifeLine Ride’s backend implements a resilient triage and help-bot pipeline with provider abstraction, caching, and fail-safe behaviors suitable for production hardening. To reach production readiness, replace in-memory stores and local caches with managed services, secure API key management, encrypt media at rest and in transit, implement robust monitoring and alerting, and establish backup and disaster recovery procedures aligned with the system’s emergency nature.

[No sources needed since this section summarizes without analyzing specific files]

## Appendices

### Infrastructure Requirements
- Compute: Containerized Python runtime with sufficient CPU/memory for concurrent AI calls and media processing.
- Database: PostgreSQL or PolarDB with spatial extensions enabled for GPS proximity matching and BHU/responder lookups.
- Storage: Encrypted object store for temporary incident media (photos, voice notes); lifecycle policies to auto-delete after retention.
- Networking: Outbound access to AI service endpoints; inbound HTTPS termination via reverse proxy/load balancer.

**Section sources**
- [PROJECT.md:17-20](file://PROJECT.md#L17-L20)
- [village-emergency-response-system-spec.md:93-100](file://village-emergency-response-system-spec.md#L93-L100)

### Deployment Topology Options
- Single-node container: Suitable for dev/test; includes app, caches, and minimal services.
- Multi-container microservices: Separate API server, help-bot workers, and background jobs; scale horizontally.
- Serverless/API gateway: Expose endpoints via managed API gateway; use function compute for bursty workloads.

[No sources needed since this section provides general guidance]

### Scaling for Concurrent Emergency Requests
- Horizontal scaling: Add instances behind load balancer; ensure shared state via database and object storage.
- Queueing: Decouple STT/vision/classifier calls using message queues to smooth spikes.
- Rate limiting: Enforce per-client and global quotas to protect AI providers and downstream services.
- Circuit breakers: Fail fast on degraded providers; route to fallback models or safe defaults.

[No sources needed since this section provides general guidance]

### Monitoring Strategies
- Health checks: Liveness/readiness probes for containers; dependency health for AI services and DB.
- Metrics: Request latency, error rates, quota usage, cache hit ratios, queue depths, DB query latencies.
- Alerts: Thresholds for high error rates, slow responses, quota exhaustion, and escalations.
- Tracing: End-to-end traces across STT, vision, classifier, and dispatch steps.

[No sources needed since this section provides general guidance]

### Log Management
- Centralized logging: Ship structured logs to a log aggregation service; include incident IDs and timestamps.
- Retention: Define retention policies aligned with privacy requirements; mask sensitive data.
- Audit trails: Capture escalation events, state transitions, and operator actions.

**Section sources**
- [backend/services/help_bot_service.py:696-717](file://backend/services/help_bot_service.py#L696-L717)
- [backend/slice_runner.py:665-672](file://backend/slice_runner.py#L665-L672)

### Backup and Recovery
- Database backups: Automated daily snapshots with point-in-time recovery; test restore procedures regularly.
- Object storage: Versioning and cross-region replication for media; define lifecycle rules for deletion.
- Configuration backups: Securely back up .env and secrets; rotate keys periodically.

[No sources needed since this section provides general guidance]

### Disaster Recovery Planning
- RTO/RPO targets: Define acceptable recovery time and data loss windows for emergency operations.
- Failover: Multi-region deployments with DNS failover; warm standby environments.
- Runbooks: Document step-by-step recovery procedures for DB restoration, media retrieval, and service restarts.

[No sources needed since this section provides general guidance]

### Security Considerations
- API key management: Store keys in secret managers; never commit to repositories; rotate regularly.
- Encryption: Encrypt media at rest in object storage; enforce TLS in transit for all endpoints.
- Access control: Role-based access for admin/BHU dashboards; least privilege for service accounts.
- Data privacy: Auto-delete sensitive media post-resolution; limit retention; audit access.

**Section sources**
- [backend/slice_runner.py:11-52](file://backend/slice_runner.py#L11-L52)
- [village-emergency-response-system-spec.md:196-198](file://village-emergency-response-system-spec.md#L196-L198)

### Operational Procedures
- Log rotation and archival: Implement automated rotation; archive to cold storage as needed.
- Periodic audits: Review escalation logs, triage accuracy, and help-bot transitions for quality assurance.
- Maintenance windows: Schedule updates during low-traffic periods; maintain backward compatibility for schemas.

[No sources needed since this section provides general guidance]

### Performance Tuning Recommendations
- Tune AI call timeouts and retries based on observed latency distributions.
- Increase cache sizes and TTLs for frequently accessed TTS lines and triage results.
- Optimize DB queries with proper indexing for spatial lookups; analyze slow query logs.
- Profile media processing pipelines to reduce CPU and memory peaks.

[No sources needed since this section provides general guidance]

### Maintenance Procedures for Long-Term Reliability
- Dependency updates: Regularly update Python packages and AI SDKs; test against regressions.
- Model versioning: Pin model versions where possible; manage drift and evaluate new models incrementally.
- Capacity planning: Monitor growth in media and logs; right-size storage and compute resources.

[No sources needed since this section provides general guidance]