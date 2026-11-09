"""Per-service NORMAL behaviour profiles used by the synthetic generator.

Timeouts and retries come from the Phase 1 services' real configuration (checked against the
.env.example files by tests/test_contracts.py):

    caller            -> service            timeout   retries
    api-gateway       -> auth-service       2000 ms   0   (the Gateway never retries)
    api-gateway       -> order-service      15000 ms  0
    order-service     -> payment-service    1500 ms   2
    order-service     -> inventory-service  1500 ms   2
    order-service     -> notification-svc   1000 ms   0   (best effort, no retries)

The rate, latency and error numbers are ILLUSTRATIVE assumptions, not measurements of your
machine. Compare them with your real Phase 2 dashboards and adjust them if you want a closer
match. Anything learned from this data describes this generator, not production.
"""

from __future__ import annotations

from dataclasses import dataclass

from anomaly_engine.features import SERVICES


@dataclass(frozen=True)
class ServiceProfile:
    name: str
    base_rate: float  # mean requests per second at normal operation
    latency_median_s: float  # median server-side duration
    latency_sigma: float  # lognormal sigma of the duration
    base_error_prob: float  # probability that a request returns 5xx
    timeout_s: float | None  # timeout callers apply to calls to this service (None: no caller)
    retries: int  # retries callers make after a failed attempt
    diurnal_amplitude: float = 0.35  # relative day/night swing of the request rate
    diurnal_phase: float = 0.0  # fraction of a day
    rate_noise_sigma: float = 0.08  # burstiness beyond Poisson noise (lognormal sigma)
    background_timeout_prob: float = 0.0003  # rare network-level timeouts during normal operation

    @property
    def hang_latency_s(self) -> float:
        """Base duration of a hung request (the caller gives up after timeout_s)."""
        return self.timeout_s if self.timeout_s is not None else 2.0


PROFILES = {
    "api-gateway": ServiceProfile("api-gateway", 10.0, 0.030, 0.45, 0.002, None, 0),
    "auth-service": ServiceProfile("auth-service", 9.0, 0.004, 0.40, 0.001, 2.0, 0),
    "order-service": ServiceProfile("order-service", 6.0, 0.020, 0.45, 0.003, 15.0, 0),
    "payment-service": ServiceProfile("payment-service", 6.0, 0.006, 0.40, 0.003, 1.5, 2),
    "inventory-service": ServiceProfile("inventory-service", 6.0, 0.005, 0.40, 0.002, 1.5, 2),
    "notification-service": ServiceProfile("notification-service", 5.0, 0.004, 0.40, 0.003, 1.0, 0),
}

assert tuple(PROFILES) == SERVICES, "PROFILES must cover SERVICES in the same order"


def get_profile(service: str) -> ServiceProfile:
    try:
        return PROFILES[service]
    except KeyError:
        raise KeyError(f"unknown service '{service}'; known: {', '.join(SERVICES)}") from None