"""Tests for the evaluation harness (structure, calibration, determinism, report); no result is asserted."""

import json
import math

import pandas as pd
import pytest

from anomaly_engine.dataset import SMALL_CONFIG
from anomaly_engine.experiment import (
    BASELINE_MODEL,
    DEV_SEEDS,
    FINAL_SEEDS,
    IF_MODEL,
    METRICS,
    ExperimentConfig,
    main,
    paired_differences,
    render_report,
    run_experiment,
    summarize,
    write_outputs,
)

CONFIG = ExperimentConfig(split=SMALL_CONFIG, target_fprs=(0.01, 0.02), primary_fpr=0.01)


@pytest.fixture(scope="module")
def results():
    return run_experiment([0, 1], CONFIG)


def test_seed_protocol_is_the_declared_one():
    assert DEV_SEEDS == tuple(range(0, 10)) and FINAL_SEEDS == tuple(range(100, 120))
    assert not set(DEV_SEEDS) & set(FINAL_SEEDS)
    default = ExperimentConfig()
    assert default.target_fprs == (0.01, 0.005, 0.02) and default.primary_fpr == 0.01


def test_one_record_per_seed_model_and_target(results):
    assert len(results.records) == 2 * 2 * 2
    assert set(results.records["model"]) == {IF_MODEL, BASELINE_MODEL}
    assert set(results.records["target_fpr"]) == {0.01, 0.02}
    assert {"precision", "recall", "f1", "fpr", "event_recall", "missed_events", "mean_delay_s"} <= set(results.records.columns)


def test_both_models_are_calibrated_to_the_same_budget_on_calibration_data(results):
    for _, row in results.records.iterrows():
        assert row["calibration_fpr"] <= row["target_fpr"] + 1e-12, row.to_dict()


def test_metrics_are_internally_consistent(results):
    for _, r in results.records.iterrows():
        assert 0 <= r["fpr"] <= 1 and 0 <= r["event_recall"] <= 1
        assert r["detected_events"] + r["missed_events"] == r["events"] == 4 * 6
        assert r["false_alarms_per_service_day"] == pytest.approx(r["fpr"] * 2880)
    both = results.records.query("seed == 0 and target_fpr == 0.01")
    assert both["tp"].iloc[0] + both["fn"].iloc[0] == both["tp"].iloc[1] + both["fn"].iloc[1], "same test windows for both models"


def test_event_table_matches_the_records(results):
    events = results.events
    assert set(events["model"]) == {IF_MODEL, BASELINE_MODEL}
    detected = events.groupby(["seed", "model", "target_fpr"])["detected"].sum()
    for _, r in results.records.iterrows():
        assert detected[(r["seed"], r["model"], r["target_fpr"])] == r["detected_events"]


def test_the_experiment_is_deterministic():
    a = run_experiment([5], CONFIG)
    b = run_experiment([5], CONFIG)
    pd.testing.assert_frame_equal(a.records, b.records)
    pd.testing.assert_frame_equal(a.events, b.events)


def test_summary_and_paired_differences_have_the_expected_shape(results):
    summary, paired = summarize(results), paired_differences(results)
    for fpr in (0.01, 0.02):
        for model in (IF_MODEL, BASELINE_MODEL):
            assert summary[fpr][model]["f1"]["n"] == 2
        for column, _ in METRICS:
            entry = paired[fpr][column]
            assert entry["reading"] in {"higher", "lower", "no significant difference", "undetermined"}
            assert entry["favours"] in {IF_MODEL, BASELINE_MODEL, "neither"}
        assert "common_event_delay_s" in paired[fpr]


def test_report_states_its_limits_and_declares_no_winner(results):
    report = render_report(results, "dev")
    assert "SYNTHETIC" in report and "No overall winner is declared" in report
    for heading in ("## Methodology", "## Environment", "## Target FPR 1.0% (primary)", "## Limitations"):
        assert heading in report
    assert "Paired differences" in report and "Favours" in report
    assert "outperforms" not in report.lower() and "is better than" not in report.lower()


def test_outputs_are_written_valid_json_and_final_results_are_not_overwritten(results, tmp_path):
    md, js = write_outputs(results, "dev", tmp_path, "report")
    data = json.loads(js.read_text(), parse_constant=lambda c: pytest.fail(f"invalid JSON constant {c}"))
    assert data["seeds"] == [0, 1] and "paired_differences" in data and md.read_text().startswith("# Phase 4")
    with pytest.raises(FileExistsError):
        write_outputs(results, "final", tmp_path, "report")
    write_outputs(results, "final", tmp_path, "report", force=True)


def test_the_final_run_cannot_use_the_small_configuration():
    with pytest.raises(SystemExit):
        main(["--seeds", "final", "--small"])
