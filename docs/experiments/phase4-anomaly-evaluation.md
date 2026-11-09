# Phase 4 anomaly-detection evaluation (final)

> **These results come from SYNTHETIC telemetry.** They describe how the two detectors behave under this
> generator's assumptions. They do not describe production performance, and the generator's fault shapes
> were written by the same project that evaluates the detectors. Real-system evidence needs labeled chaos
> runs against the live services (Phase 5). No overall winner is declared here: read each metric with its interval.

## Methodology

- **Windows:** 30 s, non-overlapping; features: request_rate, error_rate, avg_latency, p95_latency, timeout_count.
- **Chronological split per service:** train 8640 normal windows | gap 4 | calibration 2880 normal windows | gap 4 | test 2880 windows (normal + 12 injected fault events per service).
- **Isolation Forest:** one model per service, trained only on normal training windows, log-transformed features, 200 trees, `contamination` unused.
- **Control model:** rolling median/MAD over the previous 120 windows, per-feature scale floors (0.5 x training std), score = largest robust z-score.
- **Threshold calibration (both models):** per service, the (1 - target FPR) quantile of the model's scores on the held-out normal calibration segment; alert when score > threshold. Both models therefore get the same false-alarm budget.
- **Seeds:** [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119] (20 seeds). Target FPRs: [0.01, 0.005, 0.02]; primary: 0.01.
- **Pre-declared primary metrics:** F1 and event recall at the primary target FPR. Everything else is descriptive; no correction for multiple comparisons.
- **Paired comparison:** per seed, (isolation forest - rolling baseline) on identical data; mean difference with a t-based 95% interval; a difference is reported only if the interval excludes zero.
- **Detection delay:** (first alerting window - first fault window) x 30 s over detected events only; a delay of 0 means the first fault window alerted. Read it with the missed-event count. 'Common events' restricts to events both models detected.
- **Precision caveat:** about 5% of test windows are faulty here, far above real life, so precision is optimistic; FPR is not.

## Environment

- Libraries: {"python": "3.13.12", "numpy": "2.5.4", "scipy": "1.18.1", "scikit_learn": "1.9.1", "joblib": "1.6.0"}; platform: Windows 11
- Git commit: 32b99122afb6dc3080800ef558f9cea5e12c1702 (uncommitted changes: False)
- Reproduce: `python -m anomaly_engine.experiment --seeds final`

## Target FPR 1.0% (primary)

Mean ± std over 20 seeds.

| Metric | Isolation Forest | Rolling baseline |
|---|---|---|
| precision | 0.737 ± 0.028 | 0.872 ± 0.015 |
| recall | 0.523 ± 0.047 | 0.771 ± 0.044 |
| f1 | 0.611 ± 0.038 | 0.818 ± 0.027 |
| fpr | 0.010 ± 0.001 | 0.006 ± 0.001 |
| false_alarms_per_service_day | 28.0 ± 3.2 | 17.0 ± 2.3 |
| event_recall | 0.878 ± 0.044 | 0.887 ± 0.037 |
| missed_events | 8.8 ± 3.2 | 8.2 ± 2.7 |
| mean_delay_s | 55.1 ± 11.6 | 25.0 ± 6.7 |

Achieved FPR on the calibration segment (sanity check, must be <= target): isolation_forest 0.0097, rolling_baseline 0.0059

**Paired differences (isolation forest - rolling baseline)**

| Metric | Mean diff | 95% interval | Seeds | Reading | Favours |
|---|---|---|---|---|---|
| precision | -0.1349 | [-0.1490, -0.1209] | 20 | lower | rolling_baseline |
| recall | -0.2477 | [-0.2737, -0.2218] | 20 | lower | rolling_baseline |
| f1 | -0.2066 | [-0.2259, -0.1873] | 20 | lower | rolling_baseline |
| fpr | 0.0038 | [0.0032, 0.0044] | 20 | higher | rolling_baseline |
| false_alarms_per_service_day | 10.9500 | [9.1123, 12.7877] | 20 | higher | rolling_baseline |
| event_recall | -0.0083 | [-0.0279, 0.0113] | 20 | no significant difference | neither |
| missed_events | 0.6000 | [-0.8114, 2.0114] | 20 | no significant difference | neither |
| mean_delay_s | 30.1235 | [24.0400, 36.2070] | 20 | higher | rolling_baseline |
| common_event_delay_s | 24.9976 | [19.7206, 30.2746] | 20 | higher | rolling_baseline |

## Target FPR 0.5%

Mean ± std over 20 seeds.

| Metric | Isolation Forest | Rolling baseline |
|---|---|---|
| precision | 0.808 ± 0.025 | 0.910 ± 0.013 |
| recall | 0.418 ± 0.047 | 0.757 ± 0.047 |
| f1 | 0.550 ± 0.044 | 0.825 ± 0.028 |
| fpr | 0.005 ± 0.001 | 0.004 ± 0.001 |
| false_alarms_per_service_day | 14.8 ± 1.8 | 11.3 ± 2.1 |
| event_recall | 0.805 ± 0.063 | 0.878 ± 0.041 |
| missed_events | 14.1 ± 4.5 | 8.8 ± 3.0 |
| mean_delay_s | 71.0 ± 14.3 | 26.1 ± 7.4 |

Achieved FPR on the calibration segment (sanity check, must be <= target): isolation_forest 0.0049, rolling_baseline 0.0037

**Paired differences (isolation forest - rolling baseline)**

| Metric | Mean diff | 95% interval | Seeds | Reading | Favours |
|---|---|---|---|---|---|
| precision | -0.1023 | [-0.1141, -0.0904] | 20 | lower | rolling_baseline |
| recall | -0.3386 | [-0.3664, -0.3108] | 20 | lower | rolling_baseline |
| f1 | -0.2757 | [-0.2983, -0.2531] | 20 | lower | rolling_baseline |
| fpr | 0.0012 | [0.0009, 0.0016] | 20 | higher | rolling_baseline |
| false_alarms_per_service_day | 3.5668 | [2.4740, 4.6596] | 20 | higher | rolling_baseline |
| event_recall | -0.0729 | [-0.0962, -0.0496] | 20 | lower | rolling_baseline |
| missed_events | 5.2500 | [3.5737, 6.9263] | 20 | higher | rolling_baseline |
| mean_delay_s | 44.9185 | [36.8816, 52.9554] | 20 | higher | rolling_baseline |
| common_event_delay_s | 39.2395 | [31.6611, 46.8179] | 20 | higher | rolling_baseline |

## Target FPR 2.0%

Mean ± std over 20 seeds.

| Metric | Isolation Forest | Rolling baseline |
|---|---|---|
| precision | 0.630 ± 0.028 | 0.833 ± 0.016 |
| recall | 0.642 ± 0.038 | 0.778 ± 0.042 |
| f1 | 0.635 ± 0.029 | 0.804 ± 0.026 |
| fpr | 0.020 ± 0.002 | 0.008 ± 0.001 |
| false_alarms_per_service_day | 56.6 ± 4.5 | 23.4 ± 2.5 |
| event_recall | 0.931 ± 0.035 | 0.894 ± 0.035 |
| missed_events | 5.0 ± 2.5 | 7.7 ± 2.5 |
| mean_delay_s | 39.9 ± 7.6 | 24.7 ± 6.0 |

Achieved FPR on the calibration segment (sanity check, must be <= target): isolation_forest 0.0198, rolling_baseline 0.0083

**Paired differences (isolation forest - rolling baseline)**

| Metric | Mean diff | 95% interval | Seeds | Reading | Favours |
|---|---|---|---|---|---|
| precision | -0.2034 | [-0.2184, -0.1883] | 20 | lower | rolling_baseline |
| recall | -0.1367 | [-0.1588, -0.1146] | 20 | lower | rolling_baseline |
| f1 | -0.1690 | [-0.1854, -0.1525] | 20 | lower | rolling_baseline |
| fpr | 0.0115 | [0.0106, 0.0124] | 20 | higher | rolling_baseline |
| false_alarms_per_service_day | 33.1852 | [30.5898, 35.7807] | 20 | higher | rolling_baseline |
| event_recall | 0.0368 | [0.0202, 0.0534] | 20 | higher | isolation_forest |
| missed_events | -2.6500 | [-3.8483, -1.4517] | 20 | lower | isolation_forest |
| mean_delay_s | 15.1299 | [10.9384, 19.3214] | 20 | higher | rolling_baseline |
| common_event_delay_s | 9.6244 | [5.7400, 13.5089] | 20 | higher | rolling_baseline |

## Event recall by fault type (target FPR 1.0%, mean over seeds)

| Fault type | Isolation Forest | Rolling baseline |
|---|---|---|
| error_burst | 0.719 | 0.877 |
| latency_spike | 0.927 | 0.997 |
| hang | 0.973 | 1.000 |
| traffic_surge | 0.851 | 0.650 |
| traffic_drop | 0.913 | 0.902 |

## Limitations

- Synthetic data; fault shapes, severities and normal behavior are assumptions (see `anomaly_engine/profiles.py`, `faults.py`).
- Faults are local to one service; cascades between services are not simulated.
- No concept drift or contaminated training data; training data is normal by construction.
- Crashes and unavailability are not modeled: they are handled by the `up` metric, not by these detectors.
- Calibration guarantees at most the target FPR on calibration data; ties in discrete scores can make a model's achieved FPR lower (compare the `fpr` rows).
- Hyperparameters were fixed in advance and not tuned per model; a different fixed choice could change the comparison.
- The deployed API serves only the Isolation Forest (the baseline needs history).
