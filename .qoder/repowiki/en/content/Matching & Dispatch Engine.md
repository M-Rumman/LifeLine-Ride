# Matching & Dispatch Engine

<cite>
**Referenced Files in This Document**
- [dispatch_service.py](file://backend/services/dispatch_service.py)
- [test_module3.py](file://backend/test_module3.py)
- [slice_runner.py](file://backend/slice_runner.py)
- [help_bot_runner.py](file://backend/help_bot_runner.py)
- [village-emergency-response-system-spec.md](file://village-emergency-response-system-spec.md)
- [PROJECT.md](file://PROJECT.md)
</cite>

## Update Summary
**Changes Made**
- Added comprehensive coverage of the new sophisticated dispatch service with offline-first architecture
- Enhanced documentation for thread-safe state management and concurrent operations
- Updated tiered dispatch strategies with timeout handling and fallback mechanisms
- Added detailed coverage of escalation system integration and re-dispatch capabilities
- Expanded performance considerations for large-scale matching operations
- Updated troubleshooting guide with new error scenarios and resolution strategies

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This document explains the enhanced Matching & Dispatch Engine (Module 3) that selects responders and coordinates dispatch for emergencies using GPS-based location data, availability checks, and severity-driven tiered strategies. The system features an offline-first architecture with sophisticated dispatch capabilities including timeout handling, fallback mechanisms, and comprehensive event logging. It covers:
- Ranked proximity matching with availability filtering and fallback walker
- Village-to-BHU association and responder registry integration
- Tiered dispatch logic based on severity (minor/moderate/critical) with timeout handling
- Coordination workflows involving multiple responders and BHUs
- Escalation mechanisms when no responders are available or within timeout
- Thread-safe state management for concurrent incident handling
- Comprehensive event logging and analytics tracking
- Integration with escalation systems and Module 2 help bot

The engine integrates tightly with incident registration and triage (Module 1), the responder help bot (Module 2), and outcome tracking (Module 6).

**Section sources**
- [dispatch_service.py:1-37](file://backend/services/dispatch_service.py#L1-L37)
- [test_module3.py:1-11](file://backend/test_module3.py#L1-L11)
- [village-emergency-response-system-spec.md:66-82](file://village-emergency-response-system-spec.md#L66-L82)
- [PROJECT.md:8-15](file://PROJECT.md#L8-L15)

## Project Structure
At a high level, the Matching & Dispatch Engine is implemented as a sophisticated service module with clear separation between decision logic and delivery mechanisms. The key elements include:
- Core dispatch service with offline-first architecture
- Thread-safe state management for concurrent operations
- Comprehensive event logging system
- Integration points with Module 1 (incident registration) and Module 2 (help bot)
- Test suite covering all specified behaviors
- Backward compatibility with existing slice runner functions

```mermaid
graph TB
A["Incident Registration<br/>(Module 1)"] --> B["Dispatch Service<br/>(Module 3)"]
B --> C["Responder Registry<br/>(Module 5)"]
B --> D["BHU Association<br/>(Module 5)"]
B --> E["Escalation Logic<br/>(Module 8)"]
B --> F["Outcome Tracking<br/>(Module 6)"]
G["Help Bot Runner<br/>(Module 2)"] --> B
H["Test Suite<br/>(Module 3)"] --> B
```

**Diagram sources**
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)
- [dispatch_service.py:644-658](file://backend/services/dispatch_service.py#L644-L658)
- [test_module3.py:672-681](file://backend/test_module3.py#L672-L681)
- [help_bot_runner.py:64-99](file://backend/help_bot_runner.py#L64-L99)

**Section sources**
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)
- [dispatch_service.py:644-658](file://backend/services/dispatch_service.py#L644-L658)
- [test_module3.py:672-681](file://backend/test_module3.py#L672-L681)
- [help_bot_runner.py:64-99](file://backend/help_bot_runner.py#L64-L99)

## Core Components
- **DispatchDecision**: Immutable data structure containing ranked responders, notification flags, and status
- **Thread-safe State Management**: In-memory dispatch state with locking for concurrent access
- **Offline-First Architecture**: Pure local decision logic with zero network dependencies
- **Event Logging System**: Comprehensive dispatch event tracking with timestamped logs
- **Timeout Handling**: Configurable acknowledgment timeouts with automatic fallback
- **Fallback Walker**: Sequential traversal of ranked responders on timeout or decline
- **Escalation Integration**: Seamless integration with Module 2's escalation system

Key responsibilities:
- Ensure only available responders are considered with ranked fallback
- Apply severity-tiered dispatch rules with timeout handling
- Maintain thread-safe state consistency during concurrent operations
- Log all dispatch actions for accountability and analytics
- Provide offline-first operation capability for rural deployment

**Section sources**
- [dispatch_service.py:76-89](file://backend/services/dispatch_service.py#L76-L89)
- [dispatch_service.py:96-99](file://backend/services/dispatch_service.py#L96-L99)
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)

## Architecture Overview
The Matching & Dispatch Engine orchestrates sophisticated dispatch operations with offline-first design:
1. **Decide**: Pure local decision logic with ranked responder selection
2. **Notify**: Swappable delivery layer with structured logging
3. **Monitor**: Timeout handling with automatic fallback mechanisms
4. **Escalate**: Integration with Module 2 for dynamic tier upgrades
5. **Log**: Comprehensive event tracking for analytics and debugging

```mermaid
sequenceDiagram
participant Client as "Client"
participant Helper as "Help Bot Runner"
participant Service as "Dispatch Service"
participant State as "Thread-Safe State"
participant Registry as "Responder Registry"
participant Logger as "Event Logger"
Client->>Helper : Create incident (photo + voice + GPS)
Helper->>Service : dispatchIncident(incident)
Service->>Service : decideDispatch() - pure local logic
Service->>Registry : Filter responders by village + availability
Registry-->>Service : Available responders (ranked)
Service->>State : Store dispatch state with lock
Service->>Service : sendNotification() - delivery layer
Service->>Logger : log events with timestamps
alt Timeout occurs
Service->>State : Trigger fallback walker
Service->>Registry : Next available responder
else Explicit decline
Service->>State : Immediate fallback trigger
end
Service->>Logger : Final dispatch status
Logger-->>Client : Dispatch result with full trace
```

**Diagram sources**
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)
- [dispatch_service.py:244-344](file://backend/services/dispatch_service.py#L244-L344)
- [dispatch_service.py:350-486](file://backend/services/dispatch_service.py#L350-L486)
- [test_module3.py:147-212](file://backend/test_module3.py#L147-L212)

## Detailed Component Analysis

### Offline-First Decision Logic
The core decision-making process operates entirely offline with zero network dependencies:
- Filters responders by village membership and availability status
- Maintains deterministic ranking based on original seed data order
- Applies tier-based notification rules without external calls
- Returns comprehensive decision objects with reasoning traces

```mermaid
flowchart TD
Start(["decideDispatch Entry"]) --> GetVillage["Get village_id from incident GPS"]
GetVillage --> FilterResponders["Filter responders by village + availability"]
FilterResponders --> CheckAvailable{"Any available?"}
CheckAvailable --> |No| EscalateBHU["Escalate to BHU-only"]
CheckAvailable --> |Yes| SelectPrimary["Select primary responder (first in ranked list)"]
SelectPrimary --> ApplyTier["Apply tier-based notification rules"]
ApplyTier --> ReturnDecision["Return DispatchDecision object"]
EscalateBHU --> ReturnDecision
ReturnDecision --> End(["Decision Exit"])
```

**Diagram sources**
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)

**Section sources**
- [dispatch_service.py:146-237](file://backend/services/dispatch_service.py#L146-L237)

### Thread-Safe State Management
Comprehensive state management ensures concurrent safety across multiple threads:
- Lock-protected dispatch state dictionary keyed by incident ID
- Atomic timer management for acknowledgment timeouts
- Synchronized fallback walker operations
- Thread-safe incident state updates

```mermaid
stateDiagram-v2
[*] --> Active
Active --> Acknowledged : "responder_acknowledged"
Active --> Declined : "responder_declined"
Active --> Timeout : "ack_timeout"
Acknowledged --> [*] : "incident_complete"
Declined --> Fallback : "immediate fallback"
Timeout --> Fallback : "automatic fallback"
Fallback --> Active : "next responder"
Fallback --> [*] : "all_responders_exhausted"
```

**Diagram sources**
- [dispatch_service.py:96-99](file://backend/services/dispatch_service.py#L96-L99)
- [dispatch_service.py:350-396](file://backend/services/dispatch_service.py#L350-L396)
- [dispatch_service.py:402-486](file://backend/services/dispatch_service.py#L402-L486)

**Section sources**
- [dispatch_service.py:96-99](file://backend/services/dispatch_service.py#L96-L99)
- [dispatch_service.py:350-396](file://backend/services/dispatch_service.py#L350-L396)
- [dispatch_service.py:402-486](file://backend/services/dispatch_service.py#L402-L486)

### Comprehensive Event Logging System
Every dispatch action generates timestamped events for complete audit trails:
- Responder assignment and acknowledgment events
- BHU notification events with urgency levels
- Ambulance request events for critical cases
- Fallback and escalation events with detailed reasons
- Integration with INCIDENT_STORE for persistent logging

```mermaid
classDiagram
class DispatchEvent {
+string event
+string timestamp
+string incident_id
+string responder_id
+string bhu_id
+string reason
+string tier
+int fallback_count
}
class Incident {
+string incident_id
+DispatchEvent[] dispatch_events
+int dispatch_fallback_count
+bool bhu_notified
+bool ambulance_requested
}
Incident --> DispatchEvent : "contains"
```

**Diagram sources**
- [dispatch_service.py:113-125](file://backend/services/dispatch_service.py#L113-L125)
- [dispatch_service.py:269-330](file://backend/services/dispatch_service.py#L269-L330)
- [dispatch_service.py:426-483](file://backend/services/dispatch_service.py#L426-L483)

**Section sources**
- [dispatch_service.py:113-125](file://backend/services/dispatch_service.py#L113-L125)
- [dispatch_service.py:269-330](file://backend/services/dispatch_service.py#L269-L330)
- [dispatch_service.py:426-483](file://backend/services/dispatch_service.py#L426-L483)

### Timeout Handling and Fallback Mechanisms
Sophisticated timeout management with automatic fallback walking:
- Configurable acknowledgment timeouts (default 120 seconds)
- Automatic fallback to next ranked responder on timeout
- Immediate fallback on explicit responder decline
- Exhaustion handling with BHU-only escalation

```mermaid
flowchart TD
Start(["Responser Dispatched"]) --> StartTimer["Start ack timeout timer"]
StartTimer --> WaitAck{"Await acknowledgment"}
WaitAck --> |Acknowledged| Complete["Complete successfully"]
WaitAck --> |Timeout| Fallback["Trigger fallback walker"]
WaitAck --> |Declined| ImmediateFallback["Immediate fallback"]
Fallback --> CheckNext{"More responders?"}
ImmediateFallback --> CheckNext
CheckNext --> |Yes| NextResponder["Dispatch next responder"]
CheckNext --> |No| EscalateBHU["Escalate to BHU-only"]
NextResponder --> StartTimer
EscalateBHU --> Complete
```

**Diagram sources**
- [dispatch_service.py:350-376](file://backend/services/dispatch_service.py#L350-L376)
- [dispatch_service.py:402-486](file://backend/services/dispatch_service.py#L402-L486)

**Section sources**
- [dispatch_service.py:350-376](file://backend/services/dispatch_service.py#L350-L376)
- [dispatch_service.py:402-486](file://backend/services/dispatch_service.py#L402-L486)

### Escalation System Integration
Seamless integration with Module 2's escalation system for dynamic tier upgrades:
- Re-dispatch triggers based on upgraded severity tiers
- Delta-based notification sending to avoid duplicates
- Support for BHU urgency upgrades (standby → urgent)
- Ambulance request escalation for critical tier upgrades

```mermaid
sequenceDiagram
participant Module2 as "Module 2 Help Bot"
participant Module3 as "Module 3 Dispatch"
participant State as "Dispatch State"
Module2->>Module3 : handleEscalation(incident_id, snapshot)
Module3->>State : Read current state
Module3->>Module3 : Diff old vs new tier
alt New tier needs BHU
Module3->>Module3 : sendNotification(BHU upgrade)
else New tier needs ambulance
Module3->>Module3 : Request ambulance
end
Module3->>State : Update state with new tier
Module3->>Module3 : Log escalation events
```

**Diagram sources**
- [dispatch_service.py:526-638](file://backend/services/dispatch_service.py#L526-L638)
- [test_module3.py:498-577](file://backend/test_module3.py#L498-L577)

**Section sources**
- [dispatch_service.py:526-638](file://backend/services/dispatch_service.py#L526-L638)
- [test_module3.py:498-577](file://backend/test_module3.py#L498-L577)

### Comprehensive Test Coverage
Eight-scenario test suite covering all specified behaviors:
- Ranked fallback matching with busy responders
- Village exhaustion leading to BHU-only escalation
- Critical tier simultaneous dispatch (responder + BHU + ambulance)
- Minor tier with no available responders
- Timeout fallback mechanisms
- Explicit responder decline handling
- Escalation re-dispatch functionality
- Offline verification ensuring zero network dependencies

**Section sources**
- [test_module3.py:147-212](file://backend/test_module3.py#L147-L212)
- [test_module3.py:218-265](file://backend/test_module3.py#L218-L265)
- [test_module3.py:272-327](file://backend/test_module3.py#L272-L327)
- [test_module3.py:333-374](file://backend/test_module3.py#L333-L374)
- [test_module3.py:380-424](file://backend/test_module3.py#L380-L424)
- [test_module3.py:430-492](file://backend/test_module3.py#L430-L492)
- [test_module3.py:498-577](file://backend/test_module3.py#L498-L577)
- [test_module3.py:583-652](file://backend/test_module3.py#L583-L652)

## Dependency Analysis
The Matching & Dispatch Engine has well-defined dependencies:
- **slice_runner.py**: Provides data contracts, seed data, and incident models
- **Module 2 (help_bot_service)**: Integration point for escalation handling
- **Threading library**: For concurrent timer management and state protection
- **Standard libraries**: datetime, os, threading for core functionality

```mermaid
graph TB
A["Module 1 (slice_runner)"] --> B["Module 3 (Dispatch Service)"]
C["Module 2 (Help Bot)"] --> B
D["Threading Library"] --> B
E["Standard Libraries"] --> B
B --> F["Event Logging System"]
B --> G["State Management"]
```

**Diagram sources**
- [dispatch_service.py:58-59](file://backend/services/dispatch_service.py#L58-L59)
- [dispatch_service.py:40-44](file://backend/services/dispatch_service.py#L40-L44)

**Section sources**
- [dispatch_service.py:58-59](file://backend/services/dispatch_service.py#L58-L59)
- [dispatch_service.py:40-44](file://backend/services/dispatch_service.py#L40-L44)

## Performance Considerations
For large-scale matching operations, the sophisticated dispatch service provides:
- **Offline-first architecture**: Zero network dependencies ensure consistent performance
- **Thread-safe operations**: Concurrent incident handling without race conditions
- **Efficient state management**: In-memory dispatch state with lock-based synchronization
- **Configurable timeouts**: Tunable acknowledgment periods for different deployment scenarios
- **Memory efficiency**: Lightweight data structures and lazy loading patterns

Current optimizations:
- Deterministic ranking preserves original seed data order for predictable behavior
- Lock-protected state prevents concurrent modification issues
- Daemon timers don't block process exit during testing
- Minimal object creation reduces memory overhead

Recommendations for production scaling:
- Implement connection pooling for external service integrations
- Add circuit breakers for dependency failures
- Consider distributed state management for multi-instance deployments
- Monitor memory usage for long-running processes
- Implement graceful degradation for resource constraints

[No sources needed since this section provides general guidance based on observed implementation patterns]

## Troubleshooting Guide
Common issues and their resolutions in the sophisticated dispatch system:
- **No responders available**: Verify responder availability status and village assignments; check for BHU-only escalation
- **Double-assignment prevention**: Ensure responders are marked busy during active incidents; verify thread-safe state updates
- **BH U notification failures**: Check linked BHU mappings and contact information; verify escalation paths
- **Timeout issues**: Adjust DISPATCH_ACK_TIMEOUT_S environment variable; monitor fallback walker progress
- **Concurrent access problems**: Verify thread-safe state management; check for proper lock usage
- **Event logging gaps**: Ensure dispatch events are properly appended; verify INCIDENT_STORE synchronization

Debugging steps:
- Check dispatch_events array for complete audit trail
- Monitor _DISPATCH_STATE for active incident tracking
- Verify thread-safe operations with proper lock acquisition
- Test offline functionality by blocking network access
- Validate escalation integration with Module 2

**Section sources**
- [dispatch_service.py:402-486](file://backend/services/dispatch_service.py#L402-L486)
- [dispatch_service.py:526-638](file://backend/services/dispatch_service.py#L526-L638)
- [test_module3.py:583-652](file://backend/test_module3.py#L583-L652)

## Conclusion
The enhanced Matching & Dispatch Engine provides a robust foundation for GPS-based responder selection and coordinated dispatch in rural emergency response systems. The sophisticated dispatch service introduces significant improvements over the basic implementation:

**Key Enhancements:**
- **Offline-first architecture** ensuring reliable operation in connectivity-constrained environments
- **Thread-safe state management** supporting concurrent incident processing
- **Comprehensive event logging** providing complete audit trails for accountability
- **Sophisticated timeout handling** with automatic fallback mechanisms
- **Seamless escalation integration** enabling dynamic tier upgrades
- **Extensive test coverage** validating all specified behaviors

**Architectural Benefits:**
- Clear separation between decision logic and delivery mechanisms
- Swappable notification layers for future extensibility
- Deterministic ranking ensuring predictable behavior
- Minimal external dependencies reducing failure points

The engine successfully integrates with incident registration, responder help bot, and outcome tracking to provide a comprehensive emergency response workflow. Future development should focus on implementing advanced geographic proximity matching while maintaining the current offline-first principles and thread-safety guarantees.

[No sources needed since this section summarizes without analyzing specific files]