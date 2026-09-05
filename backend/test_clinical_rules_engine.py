# -*- coding: utf-8 -*-
"""Test suite for the Clinical Rules Engine (Ambulance vs. Responder-Only Dispatch).

Tests all specified clinical taxonomy categories:
- Category A: Dual Dispatch (Responder + Ambulance)
- Category B: Single Dispatch (Local Volunteer Responder Only)
- Category C: Zero Dispatch (Self-Care Home Guidance Only)
"""
from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

import slice_runner
from services import dispatch_service


def run_clinical_rules_tests():
    print("=" * 70)
    print("RUNNING CLINICAL RULES ENGINE DISPATCH TEST SUITE")
    print("=" * 70)

    # -------------------------------------------------------------------------
    # 1. CATEGORY A: DUAL DISPATCH (Both Local Responder + Ambulance Escalated)
    # -------------------------------------------------------------------------
    cat_a_cases = [
        ("cardiac_arrest", ["cardiac_arrest"], "مریض کا دل بند ہو گیا ہے"),
        ("heart_attack", ["heart_attack", "chest_pain"], "سینے میں شدید درد اور دل کا دورہ"),
        ("stroke", ["stroke", "paralysis"], "فالج کا شدید حملہ ہے جسم سن ہو گیا"),
        ("unresponsive", ["unresponsive", "unconscious"], "مریض بے ہوش ہے اور سانس نہیں لے رہا"),
        ("choking", ["choking", "airway_blockage"], "گلے میں نوالہ پھنس گیا ہے اور دم گھٹ رہا ہے"),
        ("snakebite", ["snakebite", "puncture_wounds"], "سانپ نے کاٹ لیا ہے زہر کا خطرہ ہے"),
        ("gunshot_wound", ["gunshot_wound", "penetrating_trauma"], "گولی لگی ہے خون بہہ رہا ہے"),
        ("severe_amputation", ["severe_amputation", "machine_entanglement"], "مشین میں بازو کٹ گیا ہے"),
        ("arterial_hemorrhage", ["arterial_hemorrhage", "heavy_bleeding"], "پھوٹتا ہوا خون ہے فوارہ چھوٹ رہا ہے"),
    ]

    print("\n--- Testing Category A: Dual Dispatch (High-Acuity Life Threats) ---")
    for name, flags, text in cat_a_cases:
        res = slice_runner.evaluate_clinical_dispatch(flags, text)
        assert res["clinical_category"] == "CATEGORY_A", f"{name}: expected CATEGORY_A, got {res['clinical_category']}"
        assert res["dispatch_responder"] is True, f"{name}: expected dispatch_responder=True"
        assert res["request_ambulance"] is True, f"{name}: expected request_ambulance=True"
        assert res["escalate_bhu"] is True, f"{name}: expected escalate_bhu=True"

        # Test with decideDispatch
        inc = slice_runner.Incident(
            incident_id=f"INC-TEST-A-{name[:8]}",
            timestamp_reported="2026-09-05T00:00:00Z",
            reporter_id="REP-TEST",
            gps_location=slice_runner.GPSLocation(latitude=32.6984, longitude=72.0645, village_id="TAMMAN"),
            photo_ref="test.jpg",
            voice_transcript=text,
            severity_tier="critical",
            injury_type_flags=flags,
        )
        decision = dispatch_service.decideDispatch(inc)
        assert decision.ambulance_requested is True, f"{name} dispatch: expected ambulance_requested=True"
        assert decision.notify_bhu is True, f"{name} dispatch: expected notify_bhu=True"
        assert decision.bhu_urgency == "urgent", f"{name} dispatch: expected bhu_urgency='urgent'"
        assert decision.selected_responder is not None, f"{name} dispatch: expected responder selected"
        print(f"  [PASS] Category A: {name:20s} -> Dual Dispatch (Responder: {decision.selected_responder.name}, Ambulance: {decision.ambulance_requested})")

    # -------------------------------------------------------------------------
    # 2. CATEGORY B: SINGLE DISPATCH (Local Volunteer Responder Only)
    # -------------------------------------------------------------------------
    cat_b_cases = [
        ("closed_fracture", ["closed_fracture", "swelling"], "موٹر سائیکل سے گر کر ٹانگ کی ہڈی ٹوٹ گئی ہے"),
        ("controlled_deep_laceration", ["controlled_deep_laceration"], "چھری سے گہرا کٹ لگا ہے لیکن خون دباؤ سے رک گیا ہے"),
        ("second_degree_burn", ["second_degree_burn", "scald"], "گرم چائے گرنے سے ہاتھ پر چھالے بن گئے ہیں"),
        ("head_injury_conscious", ["head_injury_conscious"], "سر پر اینٹ لگی ہے لیکن مریض مکمل ہوش میں ہے"),
        ("heat_exhaustion", ["heat_exhaustion", "severe_dehydration"], "دھوپ میں کام کرنے سے شدید گرمی اور پانی کی کمی ہے"),
    ]

    print("\n--- Testing Category B: Single Dispatch (Local Volunteer Responder Only) ---")
    for name, flags, text in cat_b_cases:
        res = slice_runner.evaluate_clinical_dispatch(flags, text)
        assert res["clinical_category"] == "CATEGORY_B", f"{name}: expected CATEGORY_B, got {res['clinical_category']}"
        assert res["dispatch_responder"] is True, f"{name}: expected dispatch_responder=True"
        assert res["request_ambulance"] is False, f"{name}: expected request_ambulance=False"
        assert res["escalate_bhu"] is False, f"{name}: expected escalate_bhu=False"

        # Test with decideDispatch
        inc = slice_runner.Incident(
            incident_id=f"INC-TEST-B-{name[:8]}",
            timestamp_reported="2026-09-05T00:00:00Z",
            reporter_id="REP-TEST",
            gps_location=slice_runner.GPSLocation(latitude=32.6984, longitude=72.0645, village_id="TAMMAN"),
            photo_ref="test.jpg",
            voice_transcript=text,
            severity_tier="moderate",
            injury_type_flags=flags,
        )
        decision = dispatch_service.decideDispatch(inc)
        assert decision.ambulance_requested is False, f"{name} dispatch: expected ambulance_requested=False"
        assert decision.selected_responder is not None, f"{name} dispatch: expected responder selected"
        print(f"  [PASS] Category B: {name:26s} -> Single Dispatch (Responder: {decision.selected_responder.name}, Ambulance: {decision.ambulance_requested})")

    # -------------------------------------------------------------------------
    # 3. CATEGORY C: ZERO DISPATCH (Self-Care Home Guidance Only)
    # -------------------------------------------------------------------------
    cat_c_cases = [
        ("bruise", ["bruise", "contusion"], "دروازے میں انگلی آ گئی تھی نیلا نشان ہے"),
        ("minor_cut", ["minor_cut", "superficial_scratch"], "کاغذ یا ہلکی لکڑی سے معمولی خراش آئی ہے"),
        ("abrasion", ["abrasion", "mild_trauma"], "ہلکا سا رگڑ لگنے سے معمولی کٹ لگا ہے"),
    ]

    print("\n--- Testing Category C: Zero Dispatch (Self-Care Home Guidance Only) ---")
    for name, flags, text in cat_c_cases:
        res = slice_runner.evaluate_clinical_dispatch(flags, text)
        assert res["clinical_category"] == "CATEGORY_C", f"{name}: expected CATEGORY_C, got {res['clinical_category']}"
        assert res["dispatch_responder"] is False, f"{name}: expected dispatch_responder=False"
        assert res["request_ambulance"] is False, f"{name}: expected request_ambulance=False"
        assert res["escalate_bhu"] is False, f"{name}: expected escalate_bhu=False"

        # Test with decideDispatch
        inc = slice_runner.Incident(
            incident_id=f"INC-TEST-C-{name[:8]}",
            timestamp_reported="2026-09-05T00:00:00Z",
            reporter_id="REP-TEST",
            gps_location=slice_runner.GPSLocation(latitude=32.6984, longitude=72.0645, village_id="TAMMAN"),
            photo_ref="test.jpg",
            voice_transcript=text,
            severity_tier="minor",
            injury_type_flags=flags,
        )
        decision = dispatch_service.decideDispatch(inc)
        assert decision.ambulance_requested is False, f"{name} dispatch: expected ambulance_requested=False"
        assert decision.status == "self_care_only", f"{name} dispatch: expected status='self_care_only', got {decision.status}"
        print(f"  [PASS] Category C: {name:20s} -> Zero Dispatch (Status: {decision.status}, Ambulance: {decision.ambulance_requested})")

    print("\n" + "=" * 70)
    print("ALL CLINICAL RULES ENGINE TESTS PASSED SUCCESSFULLY! (17/17)")
    print("=" * 70)


if __name__ == "__main__":
    run_clinical_rules_tests()
