"""Stateless HTTP scoring API for the anomaly engine (Isolation Forest only).

    GET  /health    liveness plus which model is loaded
    GET  /model     model metadata: services, feature order, thresholds, training medians, library versions
    POST /predict   {"service": "...", "window": {five features}, "explain": true} -> score, alert, top features

Stateless: every request is scored from its own body; nothing is remembered between requests.
The model artifact is loaded once at startup from MODEL_DIR (default models/isolation_forest); if it is
missing, corrupt or incompatible the process fails fast with a clear log line.
Start it with:  python -m uvicorn anomaly_engine.api:create_app --factory --host 127.0.0.1 --port 8001
Errors use the same shape as the other FaultScope services: {"error": {"code", "message", "details?"}}.
Interactive docs: /docs.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from anomaly_engine.features import FEATURE_NAMES, WINDOW_SECONDS
from anomaly_engine.isolation_model import IsolationForestDetector, ModelLoadError

SERVICE_NAME = "anomaly-engine"
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "isolation_forest"
INTERPRETATION = (
    "Isolation Forest anomaly score (higher = more unusual). 'anomalous' means the score exceeded the threshold calibrated "
    "on normal data at the model's target false-positive rate. It flags unusual behaviour; it is not a failure probability "
    "and does not predict future failures."
)


class WindowModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_rate: float = Field(ge=0, le=1_000_000, allow_inf_nan=False, description="requests per second")
    error_rate: float = Field(ge=0, le=1, allow_inf_nan=False, description="share of 5xx responses, 0..1")
    avg_latency: float = Field(ge=0, le=3600, allow_inf_nan=False, description="seconds")
    p95_latency: float = Field(ge=0, le=3600, allow_inf_nan=False, description="seconds")
    timeout_count: float = Field(ge=0, le=1_000_000_000, allow_inf_nan=False, description="timeouts in the window")


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    service: str = Field(min_length=1, max_length=64)
    window: WindowModel
    explain: bool = True


class FeatureContribution(BaseModel):
    feature: str
    value: float
    baseline: float
    direction: Literal["above", "below", "same"]
    contribution: float


class PredictResponse(BaseModel):
    service: str
    status: Literal["normal", "anomalous"]
    is_anomalous: bool
    anomaly_score: float
    threshold: float
    margin: float
    window_seconds: int
    top_features: list[FeatureContribution]
    interpretation: str


class HealthResponse(BaseModel):
    service: str
    status: str
    model_loaded: bool
    services: list[str]
    target_fpr: Optional[float]


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Optional[list[dict]] = None


class ErrorResponse(BaseModel):
    error: ErrorBody


def _log(level: str, message: str, **fields) -> None:
    if os.environ.get("LOG_LEVEL", "info").lower() == "silent":
        return
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    entry = {"time": stamp, "level": level, "service": SERVICE_NAME, "message": message, **fields}
    print(json.dumps(entry), file=sys.stderr if level == "error" else sys.stdout, flush=True)


def _error(status: int, code: str, message: str, details=None, headers=None) -> JSONResponse:
    body: dict = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body, headers=headers)


def create_app(detector: Optional[IsolationForestDetector] = None, model_dir: Optional[Path] = None) -> FastAPI:
    """Build the API. Pass a detector (tests) or let it load the artifact from model_dir / MODEL_DIR."""
    if detector is None:
        directory = Path(model_dir or os.environ.get("MODEL_DIR") or DEFAULT_MODEL_DIR)
        try:
            detector = IsolationForestDetector.load(directory)
        except ModelLoadError as exc:
            _log("error", "model_load_failed", modelDir=str(directory), reason=str(exc))
            raise
        _log("info", "model_loaded", modelDir=str(directory), services=detector.services)

    app = FastAPI(
        title="FaultScope Anomaly Engine",
        version="1.0.0",
        description="Stateless Isolation Forest scoring of 30-second telemetry windows. " + INTERPRETATION,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = (request.headers.get("x-request-id") or str(uuid.uuid4()))[:128]
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        _log("info", "request_completed", requestId=request_id, method=request.method, path=request.url.path,
             status=response.status_code, durationMs=round((time.perf_counter() - started) * 1000, 2))
        return response

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(str(part) for part in err["loc"][1:]) or "body", "message": err["msg"]}
            for err in exc.errors()
        ]
        return _error(400, "VALIDATION_ERROR", "Request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_exception(request: Request, exc: StarletteHTTPException):
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        message = f"Route {request.method} {request.url.path} not found" if exc.status_code == 404 else str(exc.detail)
        return _error(exc.status_code, codes.get(exc.status_code, "HTTP_ERROR"), message, headers=exc.headers)

    @app.exception_handler(Exception)
    async def on_unhandled_error(request: Request, exc: Exception):
        _log("error", "unhandled_error", path=request.url.path, message=str(exc))
        return _error(500, "INTERNAL_ERROR", "Internal server error")

    @app.get("/health", response_model=HealthResponse)
    def health():
        return {
            "service": SERVICE_NAME,
            "status": "ok",
            "model_loaded": True,
            "services": detector.services,
            "target_fpr": detector.target_fpr,
        }

    @app.get("/model")
    def model_info():
        meta = detector.metadata()
        meta.pop("train_median_raw", None)
        meta["train_median_raw"] = detector.train_median_raw
        meta["interpretation"] = INTERPRETATION
        return meta

    @app.post(
        "/predict",
        response_model=PredictResponse,
        responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    )
    def predict(body: PredictRequest):
        if body.service not in detector.forests:
            known = ", ".join(detector.services)
            return _error(404, "UNKNOWN_SERVICE", f"Unknown service '{body.service}'. Known services: {known}")

        row = [getattr(body.window, name) for name in FEATURE_NAMES]
        scores, flags = detector.predict(body.service, [row])
        score, flag = float(scores[0]), bool(flags[0])
        threshold = detector.thresholds[body.service]
        top = detector.explain(body.service, row)[:3] if body.explain else []
        return {
            "service": body.service,
            "status": "anomalous" if flag else "normal",
            "is_anomalous": flag,
            "anomaly_score": score,
            "threshold": threshold,
            "margin": score - threshold,
            "window_seconds": WINDOW_SECONDS,
            "top_features": top,
            "interpretation": INTERPRETATION,
        }

    return app