"""Evaluation metrics.

Window level (every service-window of the test segment):
    precision = TP / (TP + FP)      recall = TP / (TP + FN)      F1 = harmonic mean
    FPR       = FP / (FP + TN)      expected false alarms per service per day = FPR x 2880
    Precision depends on how common faults are (about 5% of test windows here, far below 1% in real
    life), so it is optimistic. FPR does not depend on prevalence.

Event level (one fault event = one contiguous injected fault on one service):
    detected        at least one alert on that service during the event
    detection delay (first alerting window - first fault window) x 30 s, over DETECTED events only.
                    0 means the very first fault window alerted (the alert itself is emitted at the
                    end of that window). Always read it together with the missed-event count.

Paired statistics compare two models on the SAME seeds.
"""

from __future__ import annotations

import math

import numpy as np

from anomaly_engine.features import WINDOW_SECONDS


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator > 0 else math.nan


def window_metrics(y_true, y_alert) -> dict:
    truth = np.asarray(y_true, dtype=bool)
    alert = np.asarray(y_alert, dtype=bool)
    if truth.shape != alert.shape:
        raise ValueError("y_true and y_alert must have the same shape")
    tp = int(np.sum(truth & alert))
    fp = int(np.sum(~truth & alert))
    fn = int(np.sum(truth & ~alert))
    tn = int(np.sum(~truth & ~alert))
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    f1 = _ratio(2 * precision * recall, precision + recall) if tp > 0 else (0.0 if tp + fp + fn > 0 else math.nan)
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": precision, "recall": recall, "f1": f1, "fpr": _ratio(fp, fp + tn),
    }


def event_results(events, alerts_by_service: dict[str, np.ndarray]) -> list[dict]:
    """One row per fault event: detected flag and detection delay in windows/seconds."""
    rows = []
    for event in events:
        flags = np.asarray(alerts_by_service[event.service][event.start : event.end], dtype=bool)
        detected = bool(flags.any())
        delay = int(np.argmax(flags)) if detected else None
        rows.append(
            {
                "event_id": event.event_id,
                "service": event.service,
                "fault_type": event.fault_type,
                "length": event.length,
                "intensity": event.intensity,
                "ramp_windows": event.ramp_windows,
                "detected": detected,
                "delay_windows": delay,
                "delay_seconds": None if delay is None else delay * WINDOW_SECONDS,
            }
        )
    return rows


def paired_interval(differences, confidence: float = 0.95) -> dict:
    """Mean of per-seed paired differences with a t-based confidence interval (NaN pairs dropped)."""
    from scipy import stats

    d = np.asarray(differences, dtype=float)
    d = d[~np.isnan(d)]
    n = int(d.size)
    if n == 0:
        return {"n": 0, "mean": math.nan, "low": math.nan, "high": math.nan}
    mean = float(d.mean())
    if n == 1:
        return {"n": 1, "mean": mean, "low": math.nan, "high": math.nan}
    sd = float(d.std(ddof=1))
    half = float(stats.t.ppf(0.5 + confidence / 2.0, n - 1)) * sd / math.sqrt(n)
    return {"n": n, "mean": mean, "low": mean - half, "high": mean + half}


def verdict(interval: dict) -> str:
    """'higher' / 'lower' when the 95% interval of (model A - model B) excludes zero, else 'no significant difference'."""
    low, high = interval["low"], interval["high"]
    if math.isnan(low) or math.isnan(high):
        return "undetermined"
    if low > 0:
        return "higher"
    if high < 0:
        return "lower"
    return "no significant difference"