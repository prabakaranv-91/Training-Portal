"""
FastAPI backend for the personal Garmin training portal.

- Users log in with their Garmin Connect email + password (MFA supported).
- A server-side session keeps the authenticated client; the browser only holds
  an opaque, signed session id cookie.
- Data endpoints proxy Garmin Connect data for the dashboard.
"""

from __future__ import annotations

import datetime as dt
import os
import secrets
from pathlib import Path

from fastapi import Cookie, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from garmin_service import GarminService

app = FastAPI(title="Garmin Training Portal", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store: session_id -> GarminService.
# Fine for a single-user, locally-run personal app.
SESSIONS: dict[str, GarminService] = {}
COOKIE_NAME = "garmin_session"


# --------------------------------------------------------------------- models


class LoginRequest(BaseModel):
    email: str
    password: str


class MfaRequest(BaseModel):
    code: str


# ------------------------------------------------------------------- helpers


def _get_session(session_id: str | None) -> GarminService:
    if not session_id or session_id not in SESSIONS:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = SESSIONS[session_id]
    if not service.is_authenticated:
        raise HTTPException(status_code=401, detail="Login incomplete")
    return service


def _new_session(response: Response) -> tuple[str, GarminService]:
    session_id = secrets.token_urlsafe(32)
    service = GarminService()
    SESSIONS[session_id] = service
    response.set_cookie(
        COOKIE_NAME,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return session_id, service


def _today() -> str:
    return dt.date.today().isoformat()


# --------------------------------------------------------------------- routes


@app.post("/api/login")
def login(req: LoginRequest, response: Response):
    session_id, service = _new_session(response)
    try:
        result = service.login(req.email, req.password)
    except Exception as exc:  # noqa: BLE001
        SESSIONS.pop(session_id, None)
        raise HTTPException(status_code=401, detail=f"Login failed: {exc}") from exc
    return {"status": result}


@app.post("/api/mfa")
def mfa(req: MfaRequest, garmin_session: str | None = Cookie(default=None)):
    if not garmin_session or garmin_session not in SESSIONS:
        raise HTTPException(status_code=401, detail="No active login")
    service = SESSIONS[garmin_session]
    try:
        result = service.submit_mfa(req.code)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"MFA failed: {exc}") from exc
    return {"status": result}


@app.post("/api/logout")
def logout(garmin_session: str | None = Cookie(default=None)):
    if garmin_session:
        SESSIONS.pop(garmin_session, None)
    return {"status": "logged_out"}


@app.get("/api/session")
def session_status(garmin_session: str | None = Cookie(default=None)):
    authed = bool(
        garmin_session
        and garmin_session in SESSIONS
        and SESSIONS[garmin_session].is_authenticated
    )
    return {"authenticated": authed}


@app.get("/api/profile")
def profile(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.profile()


@app.get("/api/dashboard")
def dashboard(
    date: str | None = None,
    garmin_session: str | None = Cookie(default=None),
):
    service = _get_session(garmin_session)
    day = date or _today()

    stats = service.daily_stats(day)
    vo2 = service.vo2max(day)
    training = service.training_status(day)
    history = service.steps_history(7)

    training_summary = {}
    latest = (training or {}).get("mostRecentTrainingStatus", {})
    if isinstance(latest, dict):
        device_map = latest.get("latestTrainingStatusData") or {}
        for value in device_map.values():
            if isinstance(value, dict):
                training_summary = {
                    "trainingStatus": value.get("trainingStatusFeedbackPhrase"),
                    "loadRatio": value.get("acuteTrainingLoadDTO", {}).get(
                        "acwrPercent"
                    )
                    if isinstance(value.get("acuteTrainingLoadDTO"), dict)
                    else None,
                    "fitnessTrend": value.get("fitnessTrend"),
                }
                break

    return {
        "date": day,
        "summary": {
            "totalSteps": stats.get("totalSteps"),
            "stepGoal": stats.get("dailyStepGoal"),
            "totalDistanceMeters": stats.get("totalDistanceMeters"),
            "totalCalories": stats.get("totalKilocalories"),
            "activeCalories": stats.get("activeKilocalories"),
            "bmrCalories": stats.get("bmrKilocalories"),
            "floorsAscended": stats.get("floorsAscended"),
            "restingHeartRate": stats.get("restingHeartRate"),
            "minHeartRate": stats.get("minHeartRate"),
            "maxHeartRate": stats.get("maxHeartRate"),
            "averageStressLevel": stats.get("averageStressLevel"),
            "bodyBatteryHighest": stats.get("bodyBatteryHighestValue"),
            "bodyBatteryLowest": stats.get("bodyBatteryLowestValue"),
            "sleepingSeconds": stats.get("sleepingSeconds"),
            "intensityMinutes": (
                (stats.get("moderateIntensityMinutes") or 0)
                + (stats.get("vigorousIntensityMinutes") or 0) * 2
            ),
        },
        "vo2max": vo2,
        "training": training_summary,
        "history": history,
    }


@app.get("/api/vo2max/history")
def vo2max_history(
    period: str = "6m",
    garmin_session: str | None = Cookie(default=None),
):
    service = _get_session(garmin_session)
    days = {"1m": 31, "6m": 183, "1y": 366}.get(period, 183)
    end = dt.date.today()
    start = end - dt.timedelta(days=days)
    points = service.vo2max_history(start.isoformat(), end.isoformat())
    return {"period": period, "points": points}


@app.get("/api/vo2max/analysis")
def vo2max_analysis(
    period: str = "6m",
    garmin_session: str | None = Cookie(default=None),
):
    service = _get_session(garmin_session)
    days = {"1m": 31, "6m": 183, "1y": 366}.get(period, 183)
    result = service.vo2max_improving_activities(days)
    return {"period": period, **result}


@app.get("/api/running-report")
def running_report(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.running_report()


@app.get("/api/running-insights")
def running_insights(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.running_insights()


@app.get("/api/performance-analysis")
def performance_analysis(
    days: int = 90, garmin_session: str | None = Cookie(default=None)
):
    service = _get_session(garmin_session)
    days = max(14, min(days, 365))
    return service.performance_analysis(days)


@app.get("/api/training-guidance")
def training_guidance(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.training_guidance()


@app.get("/api/readiness")
def readiness(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.readiness()


@app.get("/api/weekly-report")
def weekly_report(garmin_session: str | None = Cookie(default=None)):
    service = _get_session(garmin_session)
    return service.weekly_report()


@app.get("/api/activities")
def activities(
    limit: int = 50,
    days: int | None = None,
    start: str | None = None,
    end: str | None = None,
    garmin_session: str | None = Cookie(default=None),
):
    service = _get_session(garmin_session)
    limit = max(1, min(limit, 300))
    if days is not None:
        days = max(1, min(days, 730))
    return {"activities": service.activities(limit=limit, days=days, start=start, end=end)}


@app.get("/api/activities/{activity_id}")
def activity_detail(
    activity_id: str, garmin_session: str | None = Cookie(default=None)
):
    service = _get_session(garmin_session)
    return service.activity_detail(activity_id)


@app.get("/api/activities/{activity_id}/compare")
def compare_activity(
    activity_id: str, garmin_session: str | None = Cookie(default=None)
):
    service = _get_session(garmin_session)
    return service.compare_activity(activity_id)


@app.get("/api/activities/{activity_id}/laps")
def activity_laps(
    activity_id: str, garmin_session: str | None = Cookie(default=None)
):
    service = _get_session(garmin_session)
    return service.activity_laps(activity_id)


# ----------------------------------------------------------- static frontend

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
