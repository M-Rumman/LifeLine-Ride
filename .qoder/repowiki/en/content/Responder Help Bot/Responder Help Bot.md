# Responder Help Bot

<cite>
**Referenced Files in This Document**
- [help_bot_content.py](file://backend/services/help_bot_content.py)
- [help_bot_service.py](file://backend/services/help_bot_service.py)
- [help_bot_runner.py](file://backend/help_bot_runner.py)
- [slice_runner.py](file://backend/slice_runner.py)
- [heavy_bleeding.json](file://mockdata/helpbot/scripts/heavy_bleeding.json)
- [fracture_crush.json](file://mockdata/helpbot/scripts/fracture_crush.json)
- [snakebite.json](file://mockdata/helpbot/scripts/snakebite.json)
- [manifest.json](file://mockdata/helpbot/tts_cache/manifest.json)
</cite>

## Update Summary
**Changes Made**
- Enhanced branch-specific protocol documentation with detailed medical guidance for all three injury types
- Expanded voice processing pipeline documentation with VAD parameters and barge-in mechanics
- Added comprehensive intent classification system details with provider boundaries
- Updated TTS caching mechanisms with manifest tracking and prewarming capabilities
- Enhanced escalation system documentation with incident state management
- Added concrete examples from test runs showing real-world usage patterns

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Branch-Specific Medical Protocols](#branch-specific-medical-protocols)
7. [Voice Processing Pipeline](#voice-processing-pipeline)
8. [Intent Classification System](#intent-classification-system)
9. [TTS Caching and Audio Management](#tts-caching-and-audio-management)
10. [Escalation and Incident Management](#escalation-and-incident-management)
11. [Integration with Main Triage System](#integration-with-main-triage-system)
12. [Performance Considerations](#performance-considerations)
13. [Troubleshooting Guide](#troubleshooting-guide)
14. [Conclusion](#conclusion)

## Introduction
The Responder Help Bot is a sophisticated hands-free Urdu voice guidance system designed specifically for first responders during emergency situations. This fully integrated Module 2 implementation provides comprehensive medical assistance through three specialized injury branches: heavy bleeding, fracture/crush injuries, and snakebite treatment.

The system operates as a continuous listen-think-respond loop, combining advanced voice activity detection (VAD) with barge-in capability, AI-powered intent classification, and pre-authored Urdu medical guidance. All spoken content remains strictly hardcoded to ensure safety and reliability, while AI providers are used exclusively for speech-to-text transcription and intelligent routing decisions.

Key features include:
- **Three Specialized Branches**: Heavy bleeding, fracture/crush injuries, and snakebite protocols
- **Advanced Voice Processing**: Real-time VAD with adaptive noise calibration and barge-in detection
- **AI-Assisted Routing**: Intent classification using Gemini or DashScope providers
- **Robust TTS Caching**: Pre-rendered audio files with manifest tracking for reliability
- **Comprehensive Escalation**: Automatic severity tier upgrades and dispatch integration
- **Fail-Safe Operations**: Graceful degradation when network or audio services fail

## Project Structure
The help bot spans four primary modules with extensive supporting data:

```mermaid
graph TB
A["help_bot_runner.py<br/>CLI Entry Point"] --> B["help_bot_service.py<br/>Conversation Engine"]
B --> C["help_bot_content.py<br/>Medical Content & Branches"]
B --> D["slice_runner.py<br/>Provider Integration"]
B --> E["TTS Cache<br/>Pre-rendered Audio"]
A --> F["Replay Scripts<br/>Test Scenarios"]
B --> G["Audio Stack<br/>VAD + Playback"]
```

**Diagram sources**
- [help_bot_runner.py:175-236](file://backend/help_bot_runner.py#L175-L236)
- [help_bot_service.py:663-960](file://backend/services/help_bot_service.py#L663-L960)
- [help_bot_content.py:21-255](file://backend/services/help_bot_content.py#L21-L255)
- [slice_runner.py:1-745](file://backend/slice_runner.py#L1-745)

**Section sources**
- [help_bot_runner.py:1-241](file://backend/help_bot_runner.py#L1-L241)
- [help_bot_service.py:1-960](file://backend/services/help_bot_service.py#L1-L960)
- [help_bot_content.py:1-255](file://backend/services/help_bot_content.py#L1-L255)
- [slice_runner.py:1-745](file://backend/slice_runner.py#L1-L745)

## Core Components
The system consists of several interconnected components working together to provide reliable emergency guidance:

### Conversation State Machine
Manages the complete lifecycle of a responder interaction:
- **created → initial_guidance**: Branch introduction and first step delivery
- **initial_guidance → ongoing_monitor**: Step progression based on confirmations
- **ongoing_monitor → escalated_monitor**: Emergency escalation handling
- **Any state → session_finalized**: Session completion and logging

### Provider Boundaries
Isolated interfaces for AI services with fallback mechanisms:
- **STT (Speech-to-Text)**: Urdu transcription via Gemini or DashScope
- **Intent Classification**: Context-aware routing to appropriate responses
- **TTS (Text-to-Speech)**: Cached Urdu audio generation with fail-safe playback

### Branch Routing System
Intelligent mapping of incident flags to specialized medical protocols:
- **Heavy Bleeding**: Direct pressure, elevation, tourniquet guidance
- **Fracture/Crush**: Immobilization, wound covering, splinting techniques
- **Snakebite**: Stillness maintenance, constriction removal, harmful remedy prevention

### Audio Pipeline
Real-time voice processing with emergency-optimized features:
- **VAD-based Capture**: Adaptive noise floor calibration and speech detection
- **Barge-in Detection**: Interruptible playback with echo tolerance
- **Fail-safe Playback**: Guaranteed audio continuity even during service failures

**Section sources**
- [help_bot_service.py:663-960](file://backend/services/help_bot_service.py#L663-L960)
- [help_bot_service.py:127-168](file://backend/services/help_bot_service.py#L127-L168)
- [help_bot_service.py:274-289](file://backend/services/help_bot_service.py#L274-L289)
- [help_bot_service.py:368-388](file://backend/services/help_bot_service.py#L368-L388)
- [help_bot_content.py:46-255](file://backend/services/help_bot_content.py#L46-L255)

## Architecture Overview
The help bot implements a robust conversation flow optimized for emergency scenarios:

```mermaid
sequenceDiagram
participant R as "Responder"
participant M as "MicMonitor"
participant S as "HelpBotSession"
participant STT as "Transcriber"
participant INT as "Intent Classifier"
participant TTS as "TTS + Cache"
participant ESC as "Escalation Hook"
R->>M : Speak (Urdu)
M-->>S : wav_bytes (VAD chunked)
S->>STT : transcribe(wav_bytes)
STT-->>S : transcript
S->>INT : classify(branch, transcript, context)
INT-->>S : {intent, qa_entry_id, signal, suggested_tier}
alt step_done
S->>TTS : speak next step line
TTS-->>S : wav_path
S->>R : Play audio (barge-in supported)
else in_scope_question
S->>TTS : speak QA answer
TTS-->>S : wav_path
S->>R : Play audio
else out_of_scope
S->>TTS : speak honest fallback
TTS-->>S : wav_path
S->>R : Play audio
else escalation
S->>ESC : escalateIncident(new_signals)
ESC-->>S : updated incident
S->>TTS : speak escalated guidance
TTS-->>S : wav_path
S->>R : Play audio
end
```

**Diagram sources**
- [help_bot_service.py:898-925](file://backend/services/help_bot_service.py#L898-L925)
- [help_bot_service.py:159-168](file://backend/services/help_bot_service.py#L159-L168)
- [help_bot_service.py:274-289](file://backend/services/help_bot_service.py#L274-L289)
- [help_bot_service.py:368-388](file://backend/services/help_bot_service.py#L368-L388)
- [help_bot_service.py:576-648](file://backend/services/help_bot_service.py#L576-L648)

## Detailed Component Analysis

### Conversation State Machine
The session state machine ensures consistent behavior across all emergency scenarios:

```mermaid
stateDiagram-v2
[*] --> created
created --> initial_guidance : "branch_entered"
initial_guidance --> ongoing_monitor : "step_started"
ongoing_monitor --> ongoing_monitor : "step_done"
ongoing_monitor --> escalated_monitor : "escalation_triggered"
escalated_monitor --> escalated_monitor : "ongoing_monitor"
ongoing_monitor --> session_finalized : "session_finalized"
escalated_monitor --> session_finalized : "session_finalized"
```

**Diagram sources**
- [help_bot_service.py:696-712](file://backend/services/help_bot_service.py#L696-L712)
- [help_bot_service.py:760-783](file://backend/services/help_bot_service.py#L760-783)
- [help_bot_service.py:855-868](file://backend/services/help_bot_service.py#L855-868)
- [help_bot_service.py:929-959](file://backend/services/help_bot_service.py#L929-959)

**Section sources**
- [help_bot_service.py:663-960](file://backend/services/help_bot_service.py#L663-960)

### Voice Activity Detection and Barge-In
Advanced audio processing optimized for emergency environments:

```mermaid
flowchart TD
Start(["Start capture"]) --> Calibrate["Calibrate noise floor"]
Calibrate --> Listen["Listen for speech blocks"]
Listen --> Loud{"Energy > threshold?"}
Loud --> |No| Listen
Loud --> |Yes| Record["Record pre-roll + speech"]
Record --> Silence{"Silence > limit?"}
Silence --> |No| Record
Silence --> |Yes| End(["Return wav bytes"])
```

**Diagram sources**
- [help_bot_service.py:498-519](file://backend/services/help_bot_service.py#L498-519)
- [help_bot_service.py:521-569](file://backend/services/help_bot_service.py#L521-569)
- [help_bot_service.py:405-444](file://backend/services/help_bot_service.py#L405-444)

**Section sources**
- [help_bot_service.py:456-569](file://backend/services/help_bot_service.py#L456-569)
- [help_bot_service.py:405-444](file://backend/services/help_bot_service.py#L405-444)

### Intent Classification Using AI Providers
Sophisticated routing system with strict schema enforcement:

```mermaid
flowchart TD
Build["Build prompt from branch + context"] --> Call["Call provider (Gemini/DashScope)"]
Call --> Parse["Parse JSON response"]
Parse --> Valid{"Valid intent?"}
Valid --> |Yes| Normalize["Normalize fields (qa_id, signal, tier)"]
Valid --> |No| Unclear["Return intent=unclear"]
Normalize --> Return["Return intent dict"]
Unclear --> Return
```

**Diagram sources**
- [help_bot_service.py:174-214](file://backend/services/help_bot_service.py#L174-214)
- [help_bot_service.py:216-241](file://backend/services/help_bot_service.py#L216-241)
- [help_bot_service.py:244-289](file://backend/services/help_bot_service.py#L244-289)
- [slice_runner.py:72-95](file://backend/slice_runner.py#L72-95)

**Section sources**
- [help_bot_service.py:174-289](file://backend/services/help_bot_service.py#L174-289)
- [slice_runner.py:72-95](file://backend/slice_runner.py#L72-95)

## Branch-Specific Medical Protocols

### Heavy Bleeding Protocol
Comprehensive blood loss management with progressive intervention:

**Initial Guidance:**
- Immediate direct pressure application with clean cloth
- Elevation above heart level when possible
- Continuous pressure maintenance without interruption

**Step-by-Step Instructions:**
1. **Direct Pressure**: Apply firm, continuous pressure directly on wound
2. **Elevation**: Raise injured area above heart level if feasible
3. **Cloth Management**: Add layers over soaked cloths without removing original

**In-Scope Questions:**
- Cloth soaking management: Never remove soaked cloth, add additional layers
- Pressure intensity: Apply enough pressure to stop or significantly reduce bleeding
- Duration: Maintain pressure until bleeding stops or professional help arrives
- Embedded objects: Never remove embedded objects, apply pressure around them

**Escalation Triggers:**
- Uncontrolled bleeding despite proper technique
- Patient becoming unconscious or showing signs of shock
- Breathing difficulties developing

**Section sources**
- [help_bot_content.py:52-119](file://backend/services/help_bot_content.py#L52-L119)

### Fracture/Crush Injury Protocol
Specialized immobilization and wound care for bone injuries:

**Initial Guidance:**
- Complete immobilization of injured area
- No movement or attempted straightening of fractures
- Protection of exposed wounds without direct pressure on bones

**Step-by-Step Instructions:**
1. **Immobilization**: Keep patient lying down, prevent any movement of injured area
2. **Wound Coverage**: Cover open wounds with clean cloth, avoid direct pressure on bones
3. **Splinting**: Create improvised splints from available materials

**In-Scope Questions:**
- Splint alternatives: Use other limbs or soft materials when rigid splints unavailable
- Pain management: Monitor circulation, loosen bindings if fingers become pale/blue
- Medication: Avoid food, water, or painkillers before potential surgery

**Escalation Triggers:**
- Patient becoming unconscious
- Breathing difficulties developing
- Exposed bone visible
- Severe uncontrolled bleeding

**Section sources**
- [help_bot_content.py:124-182](file://backend/services/help_bot_content.py#L124-L182)

### Snakebite Protocol
Venomous bite management focusing on venom spread prevention:

**Initial Guidance:**
- Complete stillness to prevent venom circulation
- Position bitten limb below heart level
- Remove constrictive items immediately

**Step-by-Step Instructions:**
1. **Stillness**: Keep patient completely still, minimize all movement
2. **Constriction Removal**: Remove rings, watches, tight clothing near bite site
3. **Harmful Remedy Prevention**: Prevent cutting, sucking, or tight bandaging

**In-Scope Questions:**
- Bandaging: Never apply tight bandages above bite site
- Wound cleaning: Gentle water washing only, no rubbing or ice application
- Snake identification: Safe distance photography only, never attempt capture
- Venom extraction: Absolutely no cutting or mouth suction methods

**Escalation Triggers:**
- Breathing difficulties
- Rapid swelling progression
- Vomiting or unconsciousness
- Any neurological symptoms

**Section sources**
- [help_bot_content.py:187-253](file://backend/services/help_bot_content.py#L187-L253)

## Voice Processing Pipeline

### Microphone Monitoring and VAD
Advanced audio capture system with adaptive noise handling:

**Noise Calibration:**
- Measures ambient noise levels over 1-second baseline
- Sets speech threshold at 2.5x noise floor minimum 400.0
- Adapts to varying environmental conditions

**Speech Detection:**
- Uses 80ms audio blocks for real-time energy analysis
- Requires sustained loudness (2+ consecutive blocks) to start recording
- Captures 0.4s pre-roll for natural speech beginning
- Ends after 1.2s silence or 15s maximum utterance

**Barge-In Detection:**
- Monitors playback for interruptions using raised threshold (1.8x speech threshold)
- Requires 60% of recent blocks above threshold for 0.35s duration
- Prevents self-interruption from speaker-mic echo

**Section sources**
- [help_bot_service.py:456-569](file://backend/services/help_bot_service.py#L456-569)

### Audio Playback with Fail-Safe Operations
Robust audio output system designed for emergency reliability:

**Playback Process:**
- Best-effort operation: continues even without audio hardware
- Stream-based playback with callback-driven audio delivery
- Real-time barge-in monitoring during playback
- Graceful error handling with logging and continuation

**Fail-Safe Mechanisms:**
- Pre-rendered failsafe audio for critical messages
- Automatic fallback to cached audio when synthesis fails
- Continuation of conversation flow regardless of audio issues
- Comprehensive logging for debugging and quality assurance

**Section sources**
- [help_bot_service.py:405-444](file://backend/services/help_bot_service.py#L405-444)
- [help_bot_service.py:727-757](file://backend/services/help_bot_service.py#L727-757)

## Intent Classification System

### Prompt Construction and Context Management
Sophisticated context-aware classification system:

**Prompt Elements:**
- Current branch title and ID for context
- Active step information and progress
- In-scope Q&A entries with hint keywords
- Escalation signals specific to current branch
- Recent conversation history (last 6 turns)
- Latest transcript with full context

**Classification Schema:**
- **step_done**: Confirmation of completed action or request for next step
- **in_scope_question**: Question matching predefined Q&A entries
- **out_of_scope**: Any question outside defined knowledge base
- **escalation**: Patient deterioration or emergency signals
- **unclear**: Empty input, noise, or unintelligible speech

**Provider Flexibility:**
- Primary: Gemini models with retry logic
- Backup: DashScope qwen-plus model
- Automatic failover between providers
- Consistent schema validation regardless of provider

**Section sources**
- [help_bot_service.py:174-289](file://backend/services/help_bot_service.py#L174-289)

## TTS Caching and Audio Management

### Caching Architecture
Comprehensive audio caching system for reliability and performance:

**Cache Key Generation:**
- SHA1 hash of voice + text combination
- Unique per voice model configuration
- Persistent storage in dedicated cache directory

**Manifest Tracking:**
- Records rendering provenance (model, voice, timestamp)
- Tracks truncated text for audit purposes
- Supports model migration without breaking cache validity

**Prewarming Strategy:**
- Renders all scripted lines ahead of time
- Paces requests to respect rate limits (~8s between renders)
- Handles retries with exponential backoff
- Skips already cached entries automatically

**Section sources**
- [help_bot_service.py:350-388](file://backend/services/help_bot_service.py#L350-388)
- [help_bot_runner.py:102-133](file://backend/help_bot_runner.py#L102-L133)
- [manifest.json:1-152](file://mockdata/helpbot/tts_cache/manifest.json#L1-L152)

### Audio Quality Verification
Built-in verification system for ensuring Urdu audio quality:

**Round-Trip Testing:**
- TTS generates audio from Urdu text
- STT transcribes generated audio back to text
- Comparison validates pronunciation accuracy
- Results logged for quality assurance

**Quality Metrics:**
- Source line vs. round-trip transcript comparison
- STT usability assessment
- Audio file path for manual verification
- Branch-specific coverage reporting

**Section sources**
- [help_bot_runner.py:135-172](file://backend/help_bot_runner.py#L135-L172)

## Escalation and Incident Management

### Escalation Hook System
Centralized escalation management with full audit trail:

**Severity Tier Management:**
- Only upgrades, never downgrades severity
- Supports minor → moderate → critical progression
- Automatic ambulance request for critical tier
- BHU notification flagging for moderate+ cases

**Flag Merging:**
- Additive injury type flag management
- Prevents duplicate flag entries
- Maintains comprehensive injury history
- Supports custom escalation signal labels

**Transition Logging:**
- Timestamped event records for all escalations
- Detailed trigger information and context
- Transcript excerpts for audit purposes
- Integration with main incident store

**Section sources**
- [help_bot_service.py:576-648](file://backend/services/help_bot_service.py#L576-648)

### Incident Store Integration
Seamless integration with main triage system:

**Active Incident Tracking:**
- Real-time incident object updates
- Synchronization with central store
- Concurrent access protection
- Snapshot consistency maintenance

**Dispatch Integration:**
- Automatic BHU notification marking
- Ambulance request flagging for critical cases
- Responder assignment coordination
- Status synchronization across systems

**Section sources**
- [help_bot_service.py:576-648](file://backend/services/help_bot_service.py#L576-648)
- [slice_runner.py:170-188](file://backend/slice_runner.py#L170-188)

## Integration with Main Triage System

### Branch Routing Logic
Intelligent injury type detection and routing:

**Keyword-Based Matching:**
- Multi-language keyword support (English, Urdu, regional terms)
- Priority ordering for conflict resolution
- Fallback to safest default (heavy bleeding)
- Case-insensitive matching with stemming

**Real Flag Integration:**
- Compatible with Module 1 triage outputs
- Supports complex flag combinations
- Handles partial or ambiguous classifications
- Maintains backward compatibility

**Section sources**
- [help_bot_service.py:99-116](file://backend/services/help_bot_service.py#L99-L116)

### Test and Simulation Framework
Comprehensive testing infrastructure for validation:

**Replay Mode:**
- Deterministic script execution
- Expected vs. actual outcome comparison
- Latency measurement and reporting
- Full conversation logging

**Simulation Mode:**
- Mock incident creation with realistic flags
- Provider selection and credential management
- Environment variable configuration
- Automated test scenario execution

**Section sources**
- [help_bot_runner.py:74-99](file://backend/help_bot_runner.py#L74-L99)
- [heavy_bleeding.json:1-11](file://mockdata/helpbot/scripts/heavy_bleeding.json#L1-L11)
- [fracture_crush.json:1-11](file://mockdata/helpbot/scripts/fracture_crush.json#L1-L11)
- [snakebite.json:1-11](file://mockdata/helpbot/scripts/snakebite.json#L1-L11)

## Performance Considerations

### Optimization Strategies
System designed for optimal performance in emergency scenarios:

**Latency Reduction:**
- TTS prewarming eliminates cold-start delays
- Cached audio playback bypasses synthesis overhead
- First playback delay measurement for responsiveness tracking
- Efficient VAD processing with minimal CPU usage

**Resource Management:**
- Lazy loading of audio dependencies
- Memory-efficient audio streaming
- Connection pooling for API calls
- Graceful degradation under resource constraints

**Scalability Features:**
- Provider abstraction for load distribution
- Retry logic with exponential backoff
- Circuit breaker patterns for service failures
- Stateless design enabling horizontal scaling

## Troubleshooting Guide

### Common Issues and Solutions

**Network Connectivity Problems:**
- STT/intent calls may fail; system returns "unclear" and speaks failsafe line
- Provider selection allows swapping between Gemini and DashScope
- Ensure environment variables are set correctly for target provider
- Retry logic handles transient quota/rate-limit errors gracefully

**Audio Quality Variations:**
- Mic calibration adjusts thresholds for different environments
- Noisy environments may require re-calibration before starting
- Barge-in uses raised threshold to avoid self-interruption
- Loud speakers can cause false positives; adjust sensitivity as needed

**User Interaction Patterns:**
- Responders may be stressed or speaking quickly
- System accepts short confirmations ("done") and repeats guidance if unclear
- Out-of-scope questions receive honest fallbacks
- Never improvises medical advice beyond defined scope

**TTS Quota Exhaustion:**
- Use prewarm utility to render all lines ahead of time
- Verify TTS round-trip to ensure Urdu audio quality
- Manifest tracking helps identify rendering issues
- Failsafe audio ensures continuity even during quota limits

### Operational Tips

**Testing and Validation:**
- Run replay mode with scripts for deterministic testing
- Use verify-tts to check spoken-Urdu quality and STT accuracy
- Inspect test run records for latencies, expectations, and transitions
- Monitor manifest.json for cache effectiveness

**Production Deployment:**
- Configure appropriate timeout values for network operations
- Set up proper logging for troubleshooting and monitoring
- Implement health checks for audio device availability
- Plan for graceful degradation in production environments

**Section sources**
- [help_bot_service.py:159-168](file://backend/services/help_bot_service.py#L159-L168)
- [help_bot_service.py:274-289](file://backend/services/help_bot_service.py#L274-289)
- [help_bot_service.py:498-519](file://backend/services/help_bot_service.py#L498-519)
- [help_bot_runner.py:102-172](file://backend/help_bot_runner.py#L102-L172)

## Conclusion

The Responder Help Bot represents a comprehensive solution for providing hands-free Urdu medical guidance to first responders during emergencies. The fully integrated Module 2 implementation successfully combines advanced voice processing, AI-assisted intent classification, and specialized medical protocols for three critical injury types: heavy bleeding, fracture/crush injuries, and snakebite treatment.

Key achievements include:

**Technical Excellence:**
- Robust conversation state machine with clear state transitions
- Advanced voice activity detection with adaptive noise calibration
- Reliable barge-in detection optimized for emergency environments
- Sophisticated intent classification with provider flexibility

**Medical Safety:**
- Strict adherence to pre-authored medical guidance
- Comprehensive escalation protocols for deteriorating patients
- Clear boundaries preventing AI-generated medical advice
- Fail-safe operations ensuring continuity during service failures

**Operational Reliability:**
- Comprehensive TTS caching with manifest tracking
- Graceful degradation when services are unavailable
- Extensive testing framework with replay and simulation modes
- Integration with main triage system for coordinated response

The system's design prioritizes safety, reliability, and ease of use in high-stress emergency scenarios. By keeping all medical content hardcoded while leveraging AI for ears (speech recognition) and routing (intent classification), the bot maintains strict control over medical advice while providing intelligent, context-aware assistance to first responders.

This implementation serves as a solid foundation for future enhancements, including expanded injury branches, improved voice recognition accuracy, and deeper integration with emergency response systems. The modular architecture ensures that new features can be added without compromising the core safety principles that make this system suitable for life-critical applications.