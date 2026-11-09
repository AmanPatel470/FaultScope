"""Multi-seed evaluation of the Isolation Forest and the rolling-baseline control.

Per seed: generate a fresh chronological dataset, fit both models on the NORMAL training segment,
calibrate each service's threshold on the NORMAL calibration segment at the target FPR (the same
budget for both models), then measure on the test segment (normal + injected faults).

Protocol (declared before looking at any final result)
    development seeds 0-9      used while building; free to inspect
    final seeds 100-119        run ONCE with the settings below; the report is committed
    target FPR 1% (primary), 0.5% and 2% (pre-declared sensitivity checks)
    primary metrics: F1 and event recall at the 1% target; everything else is descriptive
    no correction for multiple comparisons; a difference is reported only if the paired 95%
    interval excludes zero

Usage (from the anomaly-engine folder, venv active):
    python -m anomaly_engine.experiment --seeds dev [--small]
    python -m anomaly_engine.experiment --seeds final            (refuses to overwrite a final report)
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from anomaly_engine.baseline import RollingBaselineDetector
from anomaly_engine.calibration import alerts, calibrate_threshold
from anomaly_engine.dataset import SMALL_CONFIG, Dataset, SplitConfig, build_dataset
from anomaly_engine.faults import FAULT_TYPES
from anomaly_engine.features import FEATURE_NAMES, SERVICES, WINDOW_SECONDS, WINDOWS_PER_DAY, feature_matrix
from anomaly_engine.isolation_model import IsolationForestDetector, library_versions
from anomaly_engine.metrics import event_results, paired_interval, verdict, window_metrics

IF_MODEL = "isolation_forest"
BASELINE_MODEL = "rolling_baseline"
MODELS = (IF_MODEL, BASELINE_MODEL)

DEV_SEEDS = tuple(range(0, 10))
FINAL_SEEDS = tuple(range(100, 120))

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_ROOT = Path(__file__).resolve().parents[1]
FINAL_DIR = REPO_ROOT / "docs" / "experiments"
DEV_DIR = ENGINE_ROOT / "data" / "dev-run"

# (column, direction in which the metric is better)
METRICS = (
    ("precision", "higher"),
    ("recall", "higher"),
    ("f1", "higher"),
    ("fpr", "lower"),
    ("false_alarms_per_service_day", "lower"),
    ("event_recall", "higher"),
    ("missed_events", "lower"),
    ("mean_delay_s", "lower"),
)


@dataclass(frozen=True)
class ExperimentConfig:
    split: SplitConfig = SplitConfig()
    target_fprs: tuple = (0.01, 0.005, 0.02)
    primary_fpr: float = 0.01
    n_estimators: int = 200
    baseline_window: int = 120
    baseline_floor_fraction: float = 0.5


@dataclass
class ExperimentResults:
    config: ExperimentConfig
    seeds: tuple
    records: pd.DataFrame  # one row per seed x model x target FPR
    events: pd.DataFrame  # one row per seed x model x target FPR x fault event


def _model_scores(dataset: Dataset, config: ExperimentConfig) -> dict[str, dict[str, np.ndarray]]:
    """Anomaly scores for the complete timeline of every service, from both models."""
    train = dataset.segment("train")
    train_end = dataset.config.train_range[1]
    forest = IsolationForestDetector(n_estimators=config.n_estimators, seed=dataset.seed)
    forest.fit({s: g for s, g in train.groupby("service", sort=False)})

    scores = {IF_MODEL: {}, BASELINE_MODEL: {}}
    for service in SERVICES:
        raw = feature_matrix(dataset.service_timeline(service))
        scores[IF_MODEL][service] = forest.score(service, raw)
        baseline = RollingBaselineDetector(config.baseline_window, config.baseline_floor_fraction)
        baseline.fit(raw[:train_end])
        scores[BASELINE_MODEL][service] = baseline.score(raw)
    return scores


def run_seed(seed: int, config: ExperimentConfig) -> tuple[list[dict], list[dict]]:
    dataset = build_dataset(seed, config.split)
    scores = _model_scores(dataset, config)
    c_lo, c_hi = config.split.calibration_range
    t_lo, t_hi = config.split.test_range
    labels = {s: dataset.service_timeline(s)["label"].to_numpy() for s in SERVICES}

    records, event_rows = [], []
    for fpr in config.target_fprs:
        for model in MODELS:
            alert_flags, cal_alerts = {}, []
            for service in SERVICES:
                s = scores[model][service]
                threshold = calibrate_threshold(s[c_lo:c_hi], fpr)
                alert_flags[service] = alerts(s, threshold)
                cal_alerts.append(alert_flags[service][c_lo:c_hi])

            truth = np.concatenate([labels[s][t_lo:t_hi] for s in SERVICES])
            flags = np.concatenate([alert_flags[s][t_lo:t_hi] for s in SERVICES])
            m = window_metrics(truth, flags)

            rows = event_results(dataset.events, alert_flags)
            detected = [r for r in rows if r["detected"]]
            delays = [r["delay_seconds"] for r in detected]
            record = {
                "seed": seed, "model": model, "target_fpr": fpr, **m,
                "false_alarms_per_service_day": m["fpr"] * WINDOWS_PER_DAY,
                "calibration_fpr": float(np.concatenate(cal_alerts).mean()),
                "events": len(rows),
                "detected_events": len(detected),
                "missed_events": len(rows) - len(detected),
                "event_recall": len(detected) / len(rows) if rows else math.nan,
                "mean_delay_s": float(np.mean(delays)) if delays else math.nan,
                "median_delay_s": float(np.median(delays)) if delays else math.nan,
            }
            for fault_type in FAULT_TYPES:
                of_type = [r for r in rows if r["fault_type"] == fault_type]
                record[f"event_recall__{fault_type}"] = (
                    sum(r["detected"] for r in of_type) / len(of_type) if of_type else math.nan
                )
            records.append(record)
            event_rows.extend({"seed": seed, "model": model, "target_fpr": fpr, **r} for r in rows)
    return records, event_rows


def run_experiment(seeds, config: ExperimentConfig = ExperimentConfig(), progress=None) -> ExperimentResults:
    records, events = [], []
    for i, seed in enumerate(seeds):
        r, e = run_seed(seed, config)
        records.extend(r)
        events.extend(e)
        if progress:
            progress(i + 1, len(seeds), seed)
    return ExperimentResults(config, tuple(seeds), pd.DataFrame(records), pd.DataFrame(events))


# ------------------------------------------------------------------------------ aggregation
def summarize(results: ExperimentResults) -> dict:
    """mean / std (ddof=1) / n over seeds, per target FPR and model, for every metric."""
    out: dict = {}
    for fpr, by_fpr in results.records.groupby("target_fpr"):
        out[fpr] = {}
        for model, group in by_fpr.groupby("model"):
            out[fpr][model] = {}
            for column, _ in METRICS:
                values = group[column].dropna()
                out[fpr][model][column] = {
                    "mean": float(values.mean()) if len(values) else math.nan,
                    "std": float(values.std(ddof=1)) if len(values) > 1 else math.nan,
                    "n": int(len(values)),
                }
    return out


def _paired_series(records: pd.DataFrame, fpr: float, column: str) -> np.ndarray:
    sub = records[records["target_fpr"] == fpr]
    wide = sub.pivot(index="seed", columns="model", values=column)
    return (wide[IF_MODEL] - wide[BASELINE_MODEL]).to_numpy()


def _common_event_delay_series(events: pd.DataFrame, fpr: float) -> np.ndarray:
    """Per seed: mean delay over events detected by BOTH models, difference IF - baseline."""
    sub = events[(events["target_fpr"] == fpr) & events["detected"]]
    wide = sub.pivot_table(index=["seed", "event_id"], columns="model", values="delay_seconds", aggfunc="first")
    wide = wide.dropna(subset=[IF_MODEL, BASELINE_MODEL])
    per_seed = wide.groupby("seed").mean()
    return (per_seed[IF_MODEL] - per_seed[BASELINE_MODEL]).to_numpy()


def paired_differences(results: ExperimentResults) -> dict:
    """Per target FPR and metric: paired differences (isolation forest - baseline) with a 95% interval."""
    out: dict = {}
    for fpr in results.config.target_fprs:
        out[fpr] = {}
        for column, direction in METRICS:
            interval = paired_interval(_paired_series(results.records, fpr, column))
            reading = verdict(interval)
            favours = "neither"
            if reading in ("higher", "lower"):
                better_when = "higher" if direction == "higher" else "lower"
                favours = IF_MODEL if reading == better_when else BASELINE_MODEL
            out[fpr][column] = {**interval, "reading": reading, "favours": favours, "direction": direction}
        interval = paired_interval(_common_event_delay_series(results.events, fpr))
        reading = verdict(interval)
        favours = "neither" if reading not in ("higher", "lower") else (IF_MODEL if reading == "lower" else BASELINE_MODEL)
        out[fpr]["common_event_delay_s"] = {**interval, "reading": reading, "favours": favours, "direction": "lower"}
    return out


# ------------------------------------------------------------------------------ reporting
def _num(value, digits=3) -> str:
    return "n/a" if value is None or (isinstance(value, float) and math.isnan(value)) else f"{value:.{digits}f}"


def _git_state() -> dict:
    def run(*args):
        return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10).stdout.strip()

    try:
        return {"commit": run("rev-parse", "HEAD") or None, "uncommitted_changes": bool(run("status", "--porcelain"))}
    except Exception:  # git missing or not a repository
        return {"commit": None, "uncommitted_changes": None}


def render_report(results: ExperimentResults, label: str) -> str:
    cfg, summary, paired = results.config, summarize(results), paired_differences(results)
    n = len(results.seeds)
    versions = library_versions()
    git = _git_state()
    lines = [
        f"# Phase 4 anomaly-detection evaluation ({label})",
        "",
        "> **These results come from SYNTHETIC telemetry.** They describe how the two detectors behave under this",
        "> generator's assumptions. They do not describe production performance, and the generator's fault shapes",
        "> were written by the same project that evaluates the detectors. Real-system evidence needs labeled chaos",
        "> runs against the live services (Phase 5). No overall winner is declared here: read each metric with its interval.",
        "",
        "## Methodology",
        "",
        f"- **Windows:** {WINDOW_SECONDS} s, non-overlapping; features: {', '.join(FEATURE_NAMES)}.",
        f"- **Chronological split per service:** train {cfg.split.train_windows} normal windows | gap {cfg.split.gap_windows} |"
        f" calibration {cfg.split.calibration_windows} normal windows | gap {cfg.split.gap_windows} |"
        f" test {cfg.split.test_windows} windows (normal + {cfg.split.events_per_service} injected fault events per service).",
        "- **Isolation Forest:** one model per service, trained only on normal training windows, log-transformed features,"
        f" {cfg.n_estimators} trees, `contamination` unused.",
        f"- **Control model:** rolling median/MAD over the previous {cfg.baseline_window} windows, per-feature scale floors"
        f" ({cfg.baseline_floor_fraction} x training std), score = largest robust z-score.",
        "- **Threshold calibration (both models):** per service, the (1 - target FPR) quantile of the model's scores on the held-out"
        " normal calibration segment; alert when score > threshold. Both models therefore get the same false-alarm budget.",
        f"- **Seeds:** {list(results.seeds)} ({n} seeds). Target FPRs: {list(cfg.target_fprs)}; primary: {cfg.primary_fpr}.",
        "- **Pre-declared primary metrics:** F1 and event recall at the primary target FPR. Everything else is descriptive;"
        " no correction for multiple comparisons.",
        "- **Paired comparison:** per seed, (isolation forest - rolling baseline) on identical data; mean difference with a t-based"
        " 95% interval; a difference is reported only if the interval excludes zero.",
        "- **Detection delay:** (first alerting window - first fault window) x 30 s over detected events only; a delay of 0 means the"
        " first fault window alerted. Read it with the missed-event count. 'Common events' restricts to events both models detected.",
        "- **Precision caveat:** about 5% of test windows are faulty here, far above real life, so precision is optimistic; FPR is not.",
        "",
        "## Environment",
        "",
        f"- Libraries: {json.dumps(versions)}; platform: {platform.system()} {platform.release()}",
        f"- Git commit: {git['commit']} (uncommitted changes: {git['uncommitted_changes']})",
        f"- Reproduce: `python -m anomaly_engine.experiment --seeds {label}`",
    ]

    for fpr in cfg.target_fprs:
        tag = " (primary)" if fpr == cfg.primary_fpr else ""
        lines += ["", f"## Target FPR {fpr:.1%}{tag}", "", f"Mean ± std over {n} seeds.", "",
                  "| Metric | Isolation Forest | Rolling baseline |", "|---|---|---|"]
        for column, _ in METRICS:
            cells = []
            for model in MODELS:
                s = summary[fpr][model][column]
                digits = 1 if column in ("false_alarms_per_service_day", "mean_delay_s", "missed_events") else 3
                cells.append(f"{_num(s['mean'], digits)} ± {_num(s['std'], digits)}")
            lines.append(f"| {column} | {cells[0]} | {cells[1]} |")
        cal = results.records[results.records["target_fpr"] == fpr].groupby("model")["calibration_fpr"].mean()
        lines += ["", "Achieved FPR on the calibration segment (sanity check, must be <= target): "
                  + ", ".join(f"{m} {_num(cal[m], 4)}" for m in MODELS), "",
                  "**Paired differences (isolation forest - rolling baseline)**", "",
                  "| Metric | Mean diff | 95% interval | Seeds | Reading | Favours |", "|---|---|---|---|---|---|"]
        for column in [c for c, _ in METRICS] + ["common_event_delay_s"]:
            p = paired[fpr][column]
            lines.append(f"| {column} | {_num(p['mean'], 4)} | [{_num(p['low'], 4)}, {_num(p['high'], 4)}] | {p['n']} "
                         f"| {p['reading']} | {p['favours']} |")

    lines += ["", f"## Event recall by fault type (target FPR {cfg.primary_fpr:.1%}, mean over seeds)", "",
              "| Fault type | Isolation Forest | Rolling baseline |", "|---|---|---|"]
    primary = results.records[results.records["target_fpr"] == cfg.primary_fpr]
    for fault_type in FAULT_TYPES:
        cells = [_num(primary[primary["model"] == m][f"event_recall__{fault_type}"].mean()) for m in MODELS]
        lines.append(f"| {fault_type} | {cells[0]} | {cells[1]} |")

    lines += ["", "## Limitations", "",
              "- Synthetic data; fault shapes, severities and normal behavior are assumptions (see `anomaly_engine/profiles.py`, `faults.py`).",
              "- Faults are local to one service; cascades between services are not simulated.",
              "- No concept drift or contaminated training data; training data is normal by construction.",
              "- Crashes and unavailability are not modeled: they are handled by the `up` metric, not by these detectors.",
              "- Calibration guarantees at most the target FPR on calibration data; ties in discrete scores can make a model's achieved FPR lower (compare the `fpr` rows).",
              "- Hyperparameters were fixed in advance and not tuned per model; a different fixed choice could change the comparison.",
              "- The deployed API serves only the Isolation Forest (the baseline needs history).", ""]
    return "\n".join(lines)


def _json_safe(value):
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return None if math.isnan(value) or math.isinf(value) else float(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


def write_outputs(results: ExperimentResults, label: str, out_dir: Path, stem: str, force: bool = False) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path, json_path = out_dir / f"{stem}.md", out_dir / f"{stem}.json"
    if (md_path.exists() or json_path.exists()) and not force:
        raise FileExistsError(f"{md_path} already exists; the final run is meant to be run once (use --force to override)")
    md_path.write_text(render_report(results, label), encoding="utf-8")
    payload = {
        "label": label,
        "config": asdict(results.config),
        "seeds": list(results.seeds),
        "environment": library_versions(),
        "git": _git_state(),
        "summary": summarize(results),
        "paired_differences": paired_differences(results),
        "records": results.records.to_dict(orient="records"),
        "events": results.events.to_dict(orient="records"),
    }
    json_path.write_text(json.dumps(_json_safe(payload), separators=(",", ":")), encoding="utf-8")
    return md_path, json_path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the Isolation Forest against the rolling baseline.")
    parser.add_argument("--seeds", choices=("dev", "final"), required=True)
    parser.add_argument("--small", action="store_true", help="quick smoke run with the small configuration (dev only)")
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--force", action="store_true", help="overwrite an existing report")
    args = parser.parse_args(argv)
    if args.small and args.seeds == "final":
        parser.error("--small is only allowed with --seeds dev; the final run must use the full configuration")

    config = ExperimentConfig(split=SMALL_CONFIG if args.small else SplitConfig())
    seeds = DEV_SEEDS if args.seeds == "dev" else FINAL_SEEDS
    out_dir = args.out_dir or (DEV_DIR if args.seeds == "dev" else FINAL_DIR)
    stem = "dev-evaluation" if args.seeds == "dev" else "phase4-anomaly-evaluation"

    def progress(done, total, seed):
        print(f"  seed {seed} done ({done}/{total})", flush=True)

    print(f"Running {args.seeds} evaluation on {len(seeds)} seeds ...")
    results = run_experiment(seeds, config, progress)
    md_path, json_path = write_outputs(results, args.seeds, out_dir, stem, force=args.force or args.seeds == "dev")
    print(f"Wrote {md_path}\nWrote {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())