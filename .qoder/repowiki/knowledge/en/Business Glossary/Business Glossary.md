---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### Basic Health Unit (BHUs)
- Definition：Government primary-care clinics in Pakistan that responders and ambulances are dispatched to for critical cases; each village's responder group is pre-linked to one nearby BHU for dispatch routing.
- Aliases：BHU、Basic Health Units

### Reporter
- Definition：The family member or bystander who submits an emergency report (photo + Urdu voice note + GPS) through the app; distinct from the trained responder who responds on scene.
- Aliases：reporter、family member、bystander

### Responder
- Definition：A trained but non-professional first-responder living in a village, registered in the system and eligible to receive dispatches based on availability and proximity.
- Aliases：responder、first-responder、trained villager

### Severity Tier (Tier 1/2/3)
- Definition：The explicit triage decision produced by Module 1: Tier 1 = minor (responder only), Tier 2 = moderate (responder + BHU on standby), Tier 3 = critical (responder + BHU + ambulance simultaneously). Must be stored and visible throughout the pipeline.
- Aliases：severity_tier、triage tier、tier

### Help Bot
- Definition：Module 2's hardcoded reactive state machine that guides on-scene responders hands-free via Urdu voice, branching on injury type and escalation triggers; not a freeform conversational AI.
- Aliases：help bot、Module 2、responder help bot

### Escalation Logic (Module 8)
- Definition：Timeout and mid-incident fallback that re-routes dispatch when no responder acknowledges within a window, when a responder declines, or when the help bot detects worsening condition — upgrading severity and triggering BHU/ambulance dispatch if not already active.
- Aliases：escalation、Module 8、timeout fallback

### Outcome Confirmation
- Definition：The fraud-prevention gate that awards points to a responder only after an incident's outcome (self-resolved, taken to BHU, referred to hospital, unresolved) is confirmed by the responder or BHU staff — not self-reported.
- Aliases：outcome_confirmed_by、outcome confirmation、verified completion

### Coverage Gap
- Definition：A village flagged when no responder in its group responds within the timeout window, indicating insufficient local coverage; logged for analytics and planning.
- Aliases：coverage gap、no coverage

### Urdu-first
- Definition：Global design rule that all user-facing UI, voice prompts/responses, and notifications default to Urdu; language switching is a config flag rather than per-module decisions.
- Aliases：Urdu-first、default language: Urdu
