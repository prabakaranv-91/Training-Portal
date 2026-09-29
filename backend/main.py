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

from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import nutrition_service
import strava_service
from garmin_service import GarminService

app = FastAPI(title="Training Lab Portal", version="1.0.0")

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


class NutritionLogRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    date: dt.date | None = None


# ------------------------------------------------------------------- helpers


def _get_session(session_id: str | None) -> GarminService:
    if not session_id or session_id not in SESSIONS:
        raise HTTPException(status_code=401, detail="Not authenticated")
    service = SESSIONS[session_id]
    if not service.is_authenticated:
        raise HTTPException(status_code=401, detail="Login incomplete")
    return service


def _valid_session(session_id: str | None) -> GarminService | None:
    """Validate a session authenticated via Garmin OR Strava.

    Returns the session's GarminService (which may be unauthenticated, e.g. a
    Strava-only login) or None. Raises 401 only if neither Garmin nor Strava is
    connected.
    """
    service = SESSIONS.get(session_id) if session_id else None
    garmin_ok = bool(service and service.is_authenticated)
    if garmin_ok or strava_service.is_connected():
        return service
    raise HTTPException(status_code=401, detail="Not authenticated")


def _garmin(session_id: str | None) -> GarminService | None:
    """Return an authenticated GarminService, or None for a Strava-only login.

    Still enforces that the overall session is valid (Garmin or Strava).
    """
    service = _valid_session(session_id)
    if service and service.is_authenticated:
        return service
    return None


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
    # A full sign-out also disconnects Strava so the login screen returns.
    strava_service.disconnect()
    return {"status": "logged_out"}


@app.get("/api/session")
def session_status(garmin_session: str | None = Cookie(default=None)):
    garmin = bool(
        garmin_session
        and garmin_session in SESSIONS
        and SESSIONS[garmin_session].is_authenticated
    )
    strava = strava_service.is_connected()
    return {"authenticated": garmin or strava, "garmin": garmin, "strava": strava}


@app.get("/api/profile")
def profile(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if service:
        return service.profile()
    # Strava-only login: use the Strava athlete name.
    return {
        "fullName": strava_service.athlete_name() or "Athlete",
        "email": None,
        "source": "strava",
        "avatar": strava_service.athlete_avatar(),
    }


@app.get("/api/dashboard")
def dashboard(
    date: str | None = None,
    garmin_session: str | None = Cookie(default=None),
):
    service = _garmin(garmin_session)
    day = date or _today()

    if not service:
        # Strava-only login: no Garmin wellness data available.
        return {"date": day, "summary": {}, "vo2max": None, "training": {}, "history": []}

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
    service = _garmin(garmin_session)
    if not service:
        return {"period": period, "points": []}
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
    service = _garmin(garmin_session)
    if not service:
        return {"period": period, "activities": []}
    days = {"1m": 31, "6m": 183, "1y": 366}.get(period, 183)
    result = service.vo2max_improving_activities(days)
    return {"period": period, **result}


@app.get("/api/running-report")
def running_report(garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    service = SESSIONS.get(garmin_session) if garmin_session else None
    if not (service and service.is_authenticated):
        service = GarminService()  # Strava-only: report is built from Strava runs
    extra = strava_service.running_activities(days=366) if strava_service.is_connected() else None
    return service.running_report(extra_runs=extra)


@app.get("/api/race-prediction")
def race_prediction(garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    service = SESSIONS.get(garmin_session) if garmin_session else None
    if not (service and service.is_authenticated):
        service = GarminService()  # Strava-only: predictions come from Strava
    strava_efforts = (
        strava_service.running_activities(days=365)
        if strava_service.is_connected()
        else None
    )
    return service.race_prediction(strava_efforts=strava_efforts)


@app.get("/api/lactate-threshold")
def lactate_threshold(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if not service:
        return {"hr": None, "paceMinPerKm": None}
    return service.lactate_threshold()


@app.get("/api/running-insights")
def running_insights(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if not service:
        return {"records": [], "longestRun": None, "weekly": [], "predictions": [], "predictionBasis": None}
    return service.running_insights()


@app.get("/api/performance-analysis")
def performance_analysis(
    days: int = 90, garmin_session: str | None = Cookie(default=None)
):
    service = _garmin(garmin_session)
    if not service:
        return {}
    days = max(14, min(days, 365))
    return service.performance_analysis(days)


@app.get("/api/training-guidance")
def training_guidance(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if not service:
        return None
    return service.training_guidance()


@app.get("/api/readiness")
def readiness(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if not service:
        return None
    return service.readiness()


@app.get("/api/training-readiness/history")
def training_readiness_history(
    period: str = "3m", garmin_session: str | None = Cookie(default=None)
):
    service = _garmin(garmin_session)
    if not service:
        return {"period": period, "points": []}
    days = {"1m": 31, "3m": 92, "6m": 183, "1y": 366}.get(period, 92)
    return {"period": period, "points": service.readiness_history(days)}


@app.get("/api/weekly-report")
def weekly_report(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if not service:
        return None
    return service.weekly_report()


@app.get("/api/activities")
def activities(
    limit: int = 50,
    days: int | None = None,
    start: str | None = None,
    end: str | None = None,
    garmin_session: str | None = Cookie(default=None),
):
    service = _garmin(garmin_session)
    if not service:
        return {"activities": []}
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


# ------------------------------------------------------------ strava (extra)


def _strava_redirect_uri(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/strava/callback"


@app.get("/api/strava/status")
def strava_status():
    return strava_service.status()


@app.get("/api/strava/connect")
def strava_connect(request: Request):
    if not strava_service.is_configured():
        raise HTTPException(
            status_code=400,
            detail="Strava API credentials are not configured on the server.",
        )
    url = strava_service.auth_url(_strava_redirect_uri(request))
    return RedirectResponse(url)


@app.get("/api/strava/callback")
def strava_callback(
    request: Request, code: str | None = None, error: str | None = None
):
    if error or not code:
        return RedirectResponse("/?strava=denied")
    try:
        strava_service.exchange_code(code)
    except Exception:  # noqa: BLE001
        return RedirectResponse("/?strava=error")
    return RedirectResponse("/?strava=connected")


@app.post("/api/strava/disconnect")
def strava_disconnect():
    strava_service.disconnect()
    return {"status": "disconnected"}


@app.get("/api/strava/activities")
def strava_activities(limit: int = 50, days: int | None = None):
    if not strava_service.is_connected():
        raise HTTPException(status_code=400, detail="Strava is not connected.")
    limit = max(1, min(limit, 200))
    if days is not None:
        days = max(1, min(days, 730))
    try:
        return {"activities": strava_service.activities(limit=limit, days=days)}
    except Exception as exc:  # noqa: BLE001
        if "429" in str(exc):
            raise HTTPException(
                status_code=429,
                detail="Strava rate limit reached. Please retry in a minute.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Strava error: {exc}") from exc


@app.get("/api/strava/extras")
def strava_extras():
    if not strava_service.is_connected():
        raise HTTPException(status_code=400, detail="Strava is not connected.")
    return strava_service.extras()


# ---------------------------------------------------------------- nutrition


def _energy_for(garmin_session: str | None, day: str) -> dict:
    """Calories burned / workouts for `day` from Garmin, else Strava, else estimate."""
    service = _garmin(garmin_session)
    if service:
        try:
            return service.energy_day(day)
        except Exception:  # noqa: BLE001
            pass
    if strava_service.is_connected():
        days_back = (dt.date.today() - dt.date.fromisoformat(day)).days + 1
        try:
            acts = strava_service.activities(limit=50, days=max(1, min(days_back, 60)))
        except Exception:  # noqa: BLE001
            acts = []
        workouts = [
            {
                "name": a.get("name"),
                "type": a.get("type"),
                "kcal": a.get("calories") or 0,
                "minutes": round((a.get("durationSec") or 0) / 60),
                "distanceKm": a.get("distanceKm"),
            }
            for a in acts
            if (a.get("startTime") or "")[:10] == day
        ]
        return {"source": "strava", "bmr": None, "active": None, "workouts": workouts, "weightKg": None}
    return {"source": "estimate", "bmr": None, "active": None, "workouts": [], "weightKg": None}


@app.post("/api/nutrition/log")
def nutrition_log(req: NutritionLogRequest, garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    day = (req.date or dt.date.today()).isoformat()
    entry = nutrition_service.add_entry(req.text, day)
    return {"entry": entry, "day": nutrition_service.assess(day, _energy_for(garmin_session, day))}


@app.get("/api/nutrition/day")
def nutrition_day(date: dt.date | None = None, garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    day = (date or dt.date.today()).isoformat()
    return nutrition_service.assess(day, _energy_for(garmin_session, day))


@app.delete("/api/nutrition/entries/{entry_id}")
def nutrition_revoke(
    entry_id: str, item: int | None = None, garmin_session: str | None = Cookie(default=None)
):
    _valid_session(garmin_session)
    if not nutrition_service.set_revoked(entry_id, True, item):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "revoked"}


@app.post("/api/nutrition/entries/{entry_id}/reanalyse")
def nutrition_reanalyse(entry_id: str, garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    if not nutrition_service.reanalyse_entry(entry_id):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "reanalysed"}


@app.post("/api/nutrition/entries/{entry_id}/restore")
def nutrition_restore(
    entry_id: str, item: int | None = None, garmin_session: str | None = Cookie(default=None)
):
    _valid_session(garmin_session)
    if not nutrition_service.set_revoked(entry_id, False, item):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "restored"}


@app.get("/api/nutrition/history")
def nutrition_history(days: int = 30, garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    return {"days": nutrition_service.history(max(1, min(days, 365)))}


# ----------------------------------------------------------- static frontend

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
