"""No-CCTV, no-data unit tests for frozen V4.1 acceptance-gate postmortem."""
from __future__ import annotations

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_noise_kws_v41_failures import audit_v41, validated_frozen_report
from train_noise_augmented_kws import LABELS


META = {
    "version": "msds-temporal-cnn-v4",
    "created_utc": "2026-10-31T00:00:00+00:00",
    "model_variant": "v41_context_preserving",
    "context_seconds_per_side": 0.55,
    "accept_threshold": 0.80,
    "accept_margin": 0.15,
    "research_only": True,
    "alerts_authorized": False,
}


def item(label, top, prediction, reason, probability=0.85, margin=0.20):
    return {
        "relative_path": f"train/{label}/test.wav",
        "expected": label,
        "raw_top_class": top,
        "accepted_class": prediction,
        "correct_raw": top == label,
        "correct_accepted": prediction == label,
        "top_probability": probability,
        "top_margin": margin,
        "decision_reason": reason,
    }


def make_report():
    entries = [
        item("help", "help", "unknown", "below_fixed_threshold", 0.66, 0.40),
        item("fire", "fire", "fire", "accepted"),
        item("emergency", "unknown", "unknown", "top_class_unknown"),
        item("danger", "danger", "unknown", "below_fixed_margin", 0.90, 0.04),
        item("intruder", "fire", "unknown", "below_fixed_threshold", 0.60),
        item("police", "police", "unknown", "below_fixed_threshold", 0.63),
        item("ambulance", "ambulance", "unknown", "below_fixed_threshold", 0.78),
        item("unknown", "unknown", "unknown", "top_class_unknown"),
    ]
    return {
        "model_version": META["version"],
        "model_created_utc": META["created_utc"],
        "retraining_performed": False,
        "operational_alerts_modified": False,
        "validation_per_file": entries,
        "positive_wavs": 7,
        "unknown_wavs": 1,
        "raw_top_positive_accuracy": round(5/7,4),
        "fixed_gate_positive_recall": round(1/7,4),
        "unknown_false_positive_count": 0,
    }


class V41FrozenAuditTests(unittest.TestCase):
    def test_explains_correct_raw_rejections_without_gate_tuning(self):
        report = make_report()
        analysis = audit_v41(report, META)
        self.assertEqual(analysis["raw_correct_positive"], 5)
        self.assertEqual(analysis["correctly_accepted_positive"], 1)
        self.assertEqual(analysis["correct_raw_but_rejected"], 4)
        self.assertEqual(analysis["wrong_raw_classification"], 2)
        self.assertEqual(analysis["unknown_false_positive_count"], 0)
        self.assertEqual(analysis["correct_ranked_rejections_by_reason"]["below_fixed_threshold"],3)
        self.assertEqual(analysis["correct_ranked_rejections_by_reason"]["below_fixed_margin"],1)
        self.assertEqual(analysis["per_label"]["help"]["correctly_ranked_but_gate_rejected"],1)
        self.assertFalse(analysis["training_performed"])
        self.assertFalse(analysis["thresholds_changed"])
        self.assertFalse(analysis["live_system_changed"])
        self.assertEqual(analysis["fixed_gate"],{"threshold":0.8,"margin":0.15})
        self.assertEqual(report, make_report())

    def test_rejects_altered_frozen_model(self):
        meta=copy.deepcopy(META)
        meta["accept_threshold"]=0.50
        with self.assertRaisesRegex(ValueError,"altered gate"):
            audit_v41(make_report(),meta)
        meta=copy.deepcopy(META)
        meta["alerts_authorized"]=True
        with self.assertRaisesRegex(ValueError,"Invalid frozen"):
            validated_frozen_report(make_report(),meta)

    def test_detects_conflicting_saved_scores_or_report(self):
        report=make_report()
        report["validation_per_file"][1]["top_probability"]=0.35
        with self.assertRaisesRegex(ValueError,"acceptance violates"):
            audit_v41(report,META)
        report=make_report()
        report["validation_per_file"][1]["correct_raw"]=False
        with self.assertRaisesRegex(ValueError,"correctness is inconsistent"):
            audit_v41(report,META)
        report=make_report()
        report["raw_top_positive_accuracy"]=1.0
        with self.assertRaisesRegex(ValueError,"Aggregate validation"):
            audit_v41(report,META)

    def test_unknown_false_alarm_in_saved_report_is_counted(self):
        report=make_report()
        report["validation_per_file"][-1]=item("unknown","fire","fire","accepted")
        report["unknown_false_positive_count"]=1
        result=audit_v41(report,META)
        self.assertEqual(result["unknown_false_positive_count"],1)
        self.assertEqual(result["wrongly_accepted_keyword"],0)
        self.assertEqual(result["per_label"]["unknown"]["raw_top_unknown"],0)

    def test_missing_class_and_version_mismatch_rejected(self):
        report=make_report()
        report["validation_per_file"]=report["validation_per_file"][:-1]
        with self.assertRaisesRegex(ValueError,"all eight"):
            validated_frozen_report(report,META)
        report=make_report()
        report["model_created_utc"]="different"
        with self.assertRaisesRegex(ValueError,"does not match"):
            validated_frozen_report(report,META)


if __name__=="__main__":
    unittest.main()
