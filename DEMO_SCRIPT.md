# LifeLine Ride — Hackathon Demo Script (3-5 Minutes)

## 00:00 - 00:45 | The Rural Emergency Gap & Value Story
- Introduce the scenario: A farm injury in a remote village with no ambulance nearby.
- Highlight the pain point: Illiteracy, panic, and lack of immediate emergency dispatch.

## 00:45 - 01:45 | Flow 1: 30-Second Emergency Registration (Module 1 & 3)
- **Action:** Open Reporter view in Urdu[cite: 1].
- **Input:** Take a sample photo of a deep cut + speak Urdu voice note: *"گرنے کی وجہ سے گہرا زخم ہے اور خون بہہ رہا ہے"*[cite: 1].
- **Inspectable AI Output:** Show the resulting JSON payload displaying `severity_tier: "Tier 2"`, injury flags, and immediate dual dispatch to Responder + BHU standby[cite: 1].

## 01:45 - 02:45 | Flow 2: Hands-Free Responder Guidance & Escalation (Module 2 & 8)
- **Action:** Switch to Responder view. Responder accepts assignment[cite: 1].
- **Action:** Help Bot provides Urdu voice guidance for pressure and bandaging[cite: 1].
- **Trigger Escalation:** Responder speaks: *"مریض بے ہوش ہو رہا ہے"* (Patient losing consciousness)[cite: 1].
- **Show System Reaction:** Help Bot transitions state, auto-upgrades incident to Tier 3, and triggers simultaneous ambulance dispatch[cite: 1].

## 02:45 - 03:30 | Flow 3: Incident Closure, Points, & Analytics (Modules 5 & 6)
- **Action:** BHU signs off and confirms patient arrival[cite: 1].
- **Show Proof:** Verified points automatically credited to the responder record and incident logged to coverage-gap analytics[cite: 1].