"""
FastAPI backend for the personal Garmin training portal.

- Strava uses consent-based OAuth with encrypted browser credentials.
- Garmin uses the existing Garmin Connect login with per-user local JSON tokens.
- Data endpoints proxy Garmin Connect data for the dashboard.
"""

from __future__ import annotations

import datetime as dt
import os
import secrets
import json
import hashlib
import sqlite3
import requests
import threading
import time
from pathlib import Path

from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import auth_cookies
import food_parser_client
import garmin_auth_store
import app_db
import llm_service
import nutrition_service
import sheets_sync
import strava_service
from garmin_service import GarminService

app = FastAPI(title="Fit Squad", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=app_db.get_setting("app_config", {}).get("allowed_origins", ["http://127.0.0.1:8000", "http://localhost:8000"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def browser_auth(request: Request, call_next):
    context = None
    try:
        context = auth_cookies.bind(request)
        if request.url.path.startswith("/api/nutrition/"):
            await run_in_threadpool(_valid_session, request.cookies.get(COOKIE_NAME))
            if not _nutrition_ready():
                return JSONResponse(status_code=403, content={"detail": "Complete your Google sheet and Gemini setup before using nutrition and chat.", "code": "nutrition_setup_required"})
        response = await call_next(request)
        if response.status_code < 400:
            session_id = request.cookies.get("garmin_session")
            service = SESSIONS.get(session_id) if session_id else None
            if session_id and service and service.is_authenticated:
                await run_in_threadpool(_save_login, session_id, service)
        auth_cookies.finish(response)
        return response
    except (ValueError, UnicodeError):
        return JSONResponse(status_code=503, content={"detail": "Authentication storage is unavailable. Check the application SQLite database."})
    except (sqlite3.Error, OSError):
        return JSONResponse(status_code=503, content={"detail": "Application database is unavailable. Check permissions and disk space."})
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    finally:
        if context is not None:
            auth_cookies.reset(context)


@app.middleware("http")
async def no_stale_frontend(request: Request, call_next):
    # Browsers otherwise keep serving an old index.html/app.js after updates.
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and (path == "/" or path.endswith((".html", ".js", ".css"))):
        response.headers["Cache-Control"] = "no-cache"
    return response

# In-memory session store: session_id -> GarminService.
# Fine for a single-user, locally-run personal app.
SESSIONS: dict[str, GarminService] = {}
COOKIE_NAME = "garmin_session"
_SESSION_LOCK = threading.RLock()
SESSION_LIFETIME = 7 * 24 * 60 * 60


# --------------------------------------------------------------------- models


class LoginRequest(BaseModel):
    email: str
    password: str


class MfaRequest(BaseModel):
    code: str


class SavedGarminRequest(BaseModel):
    email: str = Field(min_length=1, max_length=254)


class GarminTokenRequest(BaseModel):
    tokens: str = Field(min_length=20, max_length=32768)


class IntegrationSettingsRequest(BaseModel):
    llm_provider: str | None = Field(default=None, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    llm_model: str | None = Field(default=None, max_length=200, pattern=r"^[a-zA-Z0-9/._:@-]+$")
    llm_api_key: str | None = Field(default=None, max_length=4096)
    llm_enabled: bool | None = None
    strava_client_id: str | None = Field(default=None, max_length=254)
    strava_client_secret: str | None = Field(default=None, max_length=4096)
    sheets_url: str | None = Field(default=None, max_length=2048)
    sheets_token: str | None = Field(default=None, max_length=4096)
    sheets_enabled: bool | None = None
    gemini_api_key: str | None = Field(default=None, max_length=4096)
    gemini_model: str | None = Field(default=None, max_length=200, pattern=r"^[a-zA-Z0-9._-]+$")
    gemini_enabled: bool | None = None
    usda_api_key: str | None = Field(default=None, max_length=4096)


class NutritionLogRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    date: dt.date | None = None


class NutritionQtyRequest(BaseModel):
    qty: float = Field(gt=0, le=10000)


class NutritionProgramRequest(BaseModel):
    program: str = Field(min_length=1, max_length=40)
    date: dt.date | None = None


class NutritionWeightRequest(BaseModel):
    kg: float = Field(ge=25, le=350)
    date: dt.date | None = None


# ------------------------------------------------------------------- helpers


def _link_current_strava(service: GarminService) -> None:
    email = str(service.email or "").strip().casefold()
    linked = auth_cookies.record("strava")
    if linked and "@" in email and not email.endswith("@local.invalid"):
        owner = app_db.account_owner("garmin", app_db.session_key(email))
        try:
            app_db.link_provider(owner, "strava", linked["userId"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from None


def _save_login(session_id: str, service: GarminService) -> None:
    account = service.export_account()
    if account["tokens"] != service.token_snapshot:
        try:
            garmin_auth_store.save_garmin_auth(session_id, account, service.auth_expires_at)
        except Exception:
            raise HTTPException(status_code=503, detail="Could not save Garmin login to SQLite. Check database permissions and available disk space.") from None
        service.token_snapshot = account["tokens"]


def _local_session(session_id: str | None) -> GarminService | None:
    if not session_id:
        return None
    with _SESSION_LOCK:
        service = SESSIONS.get(session_id)
        if service:
            if service.auth_expires_at <= time.time() or (service.is_authenticated and not garmin_auth_store.fetch_garmin_auth(session_id)):
                SESSIONS.pop(session_id, None)
                service.logout()
                return None
            if service.is_authenticated:
                _save_login(session_id, service)
            return service
        try:
            saved = garmin_auth_store.fetch_garmin_auth(session_id)
        except Exception:
            raise HTTPException(status_code=503, detail="The SQLite authentication store could not be read.") from None
        if not saved:
            return None
        service = GarminService()
        try:
            service.restore_account(saved["account"])
        except Exception:
            return None
        service.auth_expires_at = saved["expiresAt"]
        service.token_snapshot = saved["account"]["tokens"]
        _save_login(session_id, service)
        SESSIONS[session_id] = service
        return service


def _get_session(session_id: str | None) -> GarminService:
    service = _local_session(session_id)
    if service is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not service.is_authenticated:
        raise HTTPException(status_code=401, detail="Login incomplete")
    return service


def _valid_session(session_id: str | None) -> GarminService | None:
    """Validate a session authenticated via Garmin OR Strava.

    Returns the session's GarminService (which may be unauthenticated, e.g. a
    Strava-only login) or None. Raises 401 only if neither Garmin nor Strava is
    connected.
    """
    try:
        service = _local_session(session_id)
    except HTTPException:
        if not strava_service.is_connected():
            raise
        service = None
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


def _new_session(response: Response, request: Request | None = None) -> tuple[str, GarminService]:
    session_id = secrets.token_urlsafe(32)
    service = GarminService()
    service.auth_expires_at = int(time.time()) + SESSION_LIFETIME
    SESSIONS[session_id] = service
    response.set_cookie(COOKIE_NAME, session_id, httponly=True, samesite="lax", max_age=SESSION_LIFETIME,
                        secure=auth_cookies.secure_cookie(request) if request else False)
    return session_id, service


def _today() -> str:
    return dt.date.today().isoformat()


# --------------------------------------------------------------------- routes


@app.post("/api/login")
def login(req: LoginRequest, response: Response, request: Request):
    session_id, service = _new_session(response, request)
    try:
        result = service.login(req.email, req.password)
        if result == "success":
            _save_login(session_id, service)
            _link_current_strava(service)
            auth_cookies.update("setup", None)
    except HTTPException:
        SESSIONS.pop(session_id, None)
        service.logout()
        raise
    except Exception:
        SESSIONS.pop(session_id, None)
        service.logout()
        raise HTTPException(status_code=401, detail="Garmin login failed. Please check your credentials.") from None
    return {"status": result}


@app.post("/api/mfa")
def mfa(req: MfaRequest, garmin_session: str | None = Cookie(default=None)):
    if not garmin_session or garmin_session not in SESSIONS:
        raise HTTPException(status_code=401, detail="No active login")
    service = SESSIONS[garmin_session]
    try:
        result = service.submit_mfa(req.code)
    except Exception:
        raise HTTPException(status_code=401, detail="Garmin MFA failed. Please try again.") from None
    try:
        _save_login(garmin_session, service)
        _link_current_strava(service)
        auth_cookies.update("setup", None)
    except HTTPException:
        SESSIONS.pop(garmin_session, None)
        service.logout()
        raise
    return {"status": result}


@app.post("/api/garmin/import-local")
def garmin_import_local(req: SavedGarminRequest, request: Request, response: Response):
    if not request.client or request.client.host not in ("127.0.0.1", "::1") or request.url.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Existing token import is available only on localhost.")
    if request.headers.get("x-local-token-import") != "1" or request.headers.get("origin") not in (None, str(request.base_url).rstrip("/")):
        raise HTTPException(status_code=403, detail="Start token import from the local application.")
    _settings_access(request, request.cookies.get(COOKIE_NAME))
    if app_db.account_owner("garmin", app_db.session_key(req.email.strip().casefold())) != app_db.user_scope():
        raise HTTPException(status_code=404, detail="No saved Garmin login belongs to this signed-in account.")
    try:
        account = garmin_auth_store.account_for(req.email)
    except Exception:
        raise HTTPException(status_code=503, detail="The local Garmin authentication JSON file could not be read.") from None
    if not account:
        raise HTTPException(status_code=404, detail="No saved Garmin login for this email. Sign in once to save it locally.")
    session_id, service = _new_session(response, request)
    try:
        service.restore_account(account)
        _save_login(session_id, service)
    except HTTPException:
        SESSIONS.pop(session_id, None)
        service.logout()
        raise
    except Exception:
        SESSIONS.pop(session_id, None)
        service.logout()
        raise HTTPException(status_code=401, detail="Saved Garmin tokens could not be restored. Sign in again; the SQLite account was left unchanged.") from None
    return {"status": "success", "storage": "local_json"}


@app.post("/api/logout")
def logout(response: Response, garmin_session: str | None = Cookie(default=None)):
    if garmin_session:
        try:
            garmin_auth_store.delete_garmin_auth(garmin_session)
        except Exception:
            raise HTTPException(status_code=503, detail="Could not invalidate the Garmin session in SQLite. Retry sign-out.") from None
        service = SESSIONS.pop(garmin_session, None)
        if service:
            service.logout()
    response.delete_cookie(COOKIE_NAME)
    # A full sign-out also disconnects Strava so the login screen returns.
    strava_service.disconnect()
    auth_cookies.update("setup", None)
    return {"status": "logged_out"}


@app.get("/api/session")
def session_status(garmin_session: str | None = Cookie(default=None)):
    try:
        service = _local_session(garmin_session)
    except HTTPException:
        if not strava_service.is_connected():
            raise
        service = None
    garmin = bool(service and service.is_authenticated)
    strava = strava_service.is_connected()
    return {"authenticated": bool(garmin or strava), "garmin": garmin, "strava": strava, "nutritionReady": bool((garmin or strava) and _nutrition_ready())}


@app.post("/api/setup/start")
def start_setup(request: Request):
    if request.headers.get("origin") not in (None, str(request.base_url).rstrip("/")):
        raise HTTPException(status_code=403, detail="Start setup from the application.")
    if request.headers.get("x-app-settings") != "1":
        raise HTTPException(status_code=403, detail="Use Start setup.")
    _valid_session(request.cookies.get(COOKIE_NAME))
    return {"status": "authenticated"}


@app.get("/api/profile")
def profile(garmin_session: str | None = Cookie(default=None)):
    service = _garmin(garmin_session)
    if service:
        return service.profile()
    # Strava-only login: use the Strava athlete name.
    return {
        "fullName": strava_service.athlete_name() or "Athlete",
        "email": app_db.profile_email(),
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
    service = _garmin(garmin_session)
    if not (service and service.is_authenticated):
        service = GarminService()  # Strava-only: report is built from Strava runs
    extra = strava_service.running_activities(days=366) if strava_service.is_connected() else None
    return service.running_report(extra_runs=extra)


@app.get("/api/race-prediction")
def race_prediction(garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    service = _garmin(garmin_session)
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


def _strava_login_config(request: Request) -> tuple[dict, str | None]:
    return strava_service._load_config(), None


@app.get("/api/strava/connect")
def strava_connect(request: Request):
    config, expected_user = _strava_login_config(request)
    if not config:
        response = RedirectResponse("/dashboard.html?strava=app_unavailable", status_code=302)
        response.headers["Cache-Control"] = "no-store"
        return response
    state = secrets.token_urlsafe(32)
    if request.query_params.get("link") == "1":
        _get_session(request.cookies.get(COOKIE_NAME))
        app_db.set_setting("link_strava:" + app_db.session_key(state), {"owner": app_db.user_scope(), "expires": int(time.time()) + 600}, scope="oauth")
    url = strava_service.auth_url(_strava_redirect_uri(request), state, config)
    response = RedirectResponse(url, status_code=302)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.set_cookie("strava_oauth_state", state, max_age=600, httponly=True,
                        secure=auth_cookies.secure_cookie(request), samesite="lax")
    return response


@app.get("/api/strava/callback")
def strava_callback(
    request: Request, code: str | None = None, error: str | None = None, state: str | None = None,
    scope: str | None = None,
):
    expected = request.cookies.get("strava_oauth_state")
    destination = "/?strava=state_error"
    if state and expected and secrets.compare_digest(state, expected):
        destination = "/?strava=denied"
    if not error and code and state and expected and secrets.compare_digest(state, expected):
        try:
            strava_service.exchange_code(code, scope or "")
            link = app_db.get_setting("link_strava:" + app_db.session_key(state), scope="oauth")
            if link:
                _get_session(request.cookies.get(COOKIE_NAME))
                if link.get("expires", 0) <= time.time() or link["owner"] != app_db.user_scope():
                    raise ValueError("The Garmin linking session changed or expired.")
                connected = auth_cookies.record("strava")
                if not connected:
                    raise ValueError("Strava did not confirm an account.")
                app_db.link_provider(link["owner"], "strava", connected["userId"])
            destination = "/?strava=connected"
        except Exception:
            destination = "/?strava=error"
    response = RedirectResponse(destination, status_code=302)
    if state:
        with app_db.connection() as database:
            database.execute("DELETE FROM settings WHERE scope = 'oauth' AND name = ?", ("link_strava:" + app_db.session_key(state),))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.delete_cookie("strava_oauth_state", httponly=True,
                           secure=auth_cookies.secure_cookie(request), samesite="lax")
    return response


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


def _settings_access(request: Request, session_id: str | None) -> None:
    if request.headers.get("origin") not in (None, str(request.base_url).rstrip("/")):
        raise HTTPException(status_code=403, detail="Open settings from the application.")
    _valid_session(session_id)


def _nutrition_ready() -> bool:
    config = app_db.user_setting("nutrition_config", {})
    secrets_config = app_db.user_setting("nutrition_secrets", {})
    checks = app_db.get_setting("integration_checks", {}, scope=app_db.user_scope())
    sheets = config.get("google_sheets") or {}
    llm = llm_service.config()
    llm_check = checks.get("llm") or checks.get("gemini") or {}
    return bool(sheets.get("enabled") and sheets.get("web_app_url") and secrets_config.get("sheets_token") and llm.get("enabled", True) and llm_service.api_key() and checks.get("sheets", {}).get("fingerprint") == _integration_fingerprint("sheets") and llm_check.get("fingerprint") == _integration_fingerprint("llm"))


def _settings_status() -> dict:
    nutrition = app_db.user_setting("nutrition_config", {})
    secrets_config = app_db.user_setting("nutrition_secrets", {})
    sheets = nutrition.get("google_sheets") or {}
    gemini = nutrition.get("gemini") or {}
    llm = llm_service.config()
    checks = app_db.get_setting("integration_checks", {}, scope=app_db.user_scope())
    bound_request = (auth_cookies._state.get() or {}).get("request")
    garmin_service = _local_session(bound_request.cookies.get(COOKIE_NAME)) if bound_request else None
    def ready(name):
        return checks.get(name, {}).get("fingerprint") == _integration_fingerprint(name)
    return {
        "scope": "application" if app_db.user_scope() == "global" else "user",
        "strava": {"configured": strava_service.is_configured(), "ready": strava_service.is_connected()},
        "sheets": {"url": sheets.get("web_app_url") or "", "enabled": bool(sheets.get("enabled")), "tokenConfigured": bool(secrets_config.get("sheets_token")), "ready": ready("sheets") and bool(sheets.get("enabled"))},
        "gemini": {"model": gemini.get("model") or "gemini-flash-lite-latest", "enabled": bool(gemini.get("enabled", True)), "keyConfigured": bool(secrets_config.get("gemini_api_key")), "ready": ready("gemini") and bool(gemini.get("enabled", True))},
        "llm": {"provider": llm.get("provider", "gemini"), "model": llm.get("model", "gemini-flash-lite-latest"), "enabled": bool(llm.get("enabled", True)), "keyConfigured": bool(llm_service.api_key()), "ready": ready("llm") and bool(llm.get("enabled", True))},
        "garmin": {"ready": bool(garmin_service and garmin_service.is_authenticated)},
        "usda": {"keyConfigured": bool(secrets_config.get("usda_api_key"))},
        "account": {"email": app_db.profile_email(), "canLinkStrava": bool(garmin_service and garmin_service.is_authenticated)},
        "nutritionReady": _nutrition_ready(),
    }


@app.get("/api/settings/integrations")
def integration_settings(request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    return _settings_status()


@app.post("/api/settings/integrations")
def save_integration_settings(req: IntegrationSettingsRequest, request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    if request.headers.get("x-app-settings") != "1":
        raise HTTPException(status_code=403, detail="Save settings from the application form.")
    if req.strava_client_id is not None or req.strava_client_secret is not None:
        raise HTTPException(status_code=403, detail="Strava application credentials are managed by the server. Sign in with Strava instead.")
    if req.llm_provider is not None and req.llm_provider != llm_service.config().get("provider") and not (req.llm_api_key or "").strip():
        raise HTTPException(status_code=400, detail="Enter a new API key when changing the LLM provider.")
    if req.sheets_url:
        from urllib.parse import urlparse
        try:
            parsed = urlparse(req.sheets_url)
        except ValueError:
            raise HTTPException(status_code=400, detail="Use a valid Apps Script deployment URL.") from None
        if parsed.scheme != "https" or parsed.netloc.lower() not in ("script.google.com", "script.google.com:443") or not parsed.path.startswith("/macros/s/") or not parsed.path.endswith("/exec") or parsed.query or parsed.fragment:
            raise HTTPException(status_code=400, detail="Use the HTTPS Apps Script deployment URL ending in /exec.")
    scope = app_db.user_scope()
    nutrition = app_db.get_setting("nutrition_config", {}, scope=scope)
    secrets_config = app_db.get_setting("nutrition_secrets", {}, scope=scope)
    for field, key in (("sheets_token", "sheets_token"), ("gemini_api_key", "gemini_api_key"), ("usda_api_key", "usda_api_key"), ("llm_api_key", "llm_api_key")):
        value = getattr(req, field)
        if value is not None and value.strip():
            secrets_config[key] = value.strip()
    sheets = dict(nutrition.get("google_sheets") or {})
    if req.sheets_url is not None:
        sheets["web_app_url"] = req.sheets_url.strip()
    if req.sheets_enabled is not None:
        sheets["enabled"] = req.sheets_enabled
    gemini = dict(nutrition.get("gemini") or {})
    if req.gemini_model is not None:
        gemini["model"] = req.gemini_model
    if req.gemini_enabled is not None:
        gemini["enabled"] = req.gemini_enabled
    nutrition.update(google_sheets=sheets, gemini=gemini)
    llm = dict(nutrition.get("llm") or {})
    if req.llm_provider is not None:
        llm["provider"] = req.llm_provider
    if req.llm_model is not None:
        llm["model"] = req.llm_model
    if req.llm_enabled is not None:
        llm["enabled"] = req.llm_enabled
    elif req.gemini_enabled is not None:
        llm["enabled"] = req.gemini_enabled
    if llm:
        nutrition["llm"] = llm
    with app_db.connection() as database:
        for name, value in (("nutrition_config", nutrition), ("nutrition_secrets", secrets_config)):
            database.execute("INSERT INTO settings(scope, name, value) VALUES (?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value", (scope, name, json.dumps(value)))
    food_parser_client._cache.clear()
    return _settings_status()


def _integration_fingerprint(name: str) -> str:
    config = app_db.user_setting("nutrition_config", {})
    secret = app_db.user_setting("nutrition_secrets", {})
    values = [(config.get("google_sheets") or {}).get("web_app_url"), secret.get("sheets_token")] if name == "sheets" else [llm_service.config().get("provider"), llm_service.config().get("model"), llm_service.api_key()]
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


@app.post("/api/settings/check/{provider}")
def check_integration(provider: str, request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    if request.headers.get("x-app-settings") != "1":
        raise HTTPException(status_code=403, detail="Use the setup form to check the connection.")
    if provider not in ("sheets", "llm", "gemini"):
        raise HTTPException(status_code=404, detail="Unknown integration.")
    config = app_db.user_setting("nutrition_config", {})
    if provider == "sheets":
        if not sheets_sync._config().get("web_app_url") or not sheets_sync._token():
            raise HTTPException(status_code=400, detail="Save the deployment URL and token before checking your sheet.")
        try:
            result = sheets_sync._post({"action": "info"})
            if not result.get("ok"):
                raise ValueError("Sheet did not confirm readiness")
        except Exception:
            raise HTTPException(status_code=400, detail="Could not connect to your sheet. Check the deployment URL, token and access setting, then deploy a new version.") from None
        config.setdefault("google_sheets", {})["enabled"] = True
    else:
        if not llm_service.api_key():
            raise HTTPException(status_code=400, detail="Save your LLM provider API key in Settings first.")
        try:
            checked = llm_service.generate('Return an object with "ok" set to true.', {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]})
            if checked.get("ok") is not True:
                raise ValueError("Model did not confirm readiness")
        except Exception:
            raise HTTPException(status_code=400, detail="Could not verify the selected LLM. Check provider, model, API key and quota in Settings.") from None
        config["llm"] = {**llm_service.config(), "enabled": True}
    scope = app_db.user_scope()
    checks = app_db.get_setting("integration_checks", {}, scope=scope)
    checks[provider] = {"fingerprint": _integration_fingerprint(provider), "checkedAt": int(time.time())}
    app_db.set_setting("integration_checks", checks, scope=scope)
    app_db.set_setting("nutrition_config", config, scope=scope)
    return _settings_status()


@app.post("/api/settings/sheets/token")
def generate_sheet_token(request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    if request.headers.get("x-app-settings") != "1":
        raise HTTPException(status_code=403, detail="Use the setup form.")
    scope = app_db.user_scope()
    saved = app_db.get_setting("nutrition_secrets", {}, scope=scope)
    if not saved.get("sheets_token"):
        saved["sheets_token"] = secrets.token_urlsafe(32)
        app_db.set_setting("nutrition_secrets", saved, scope=scope)
    return {"tokenConfigured": True}


@app.get("/api/settings/sheets/script")
def download_sheet_script(request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    token = sheets_sync._token()
    if not token:
        raise HTTPException(status_code=400, detail="Generate or save your sheet token first.")
    script = (Path(__file__).resolve().parent / "apps_script" / "Code.gs").read_text(encoding="utf-8")
    script = script.replace('"PASTE_SHEETS_TOKEN_HERE"', json.dumps(token), 1)
    return Response(script, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="nutrition_sheets.gs"', "Cache-Control": "no-store"})


@app.post("/api/settings/garmin/token")
def import_garmin_token(req: GarminTokenRequest, request: Request, response: Response, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    if request.headers.get("x-app-settings") != "1":
        raise HTTPException(status_code=403, detail="Use the Garmin setup step.")
    session_id, service = _new_session(response, request)
    try:
        service.restore_account({"tokens": req.tokens, "email": f"token-{app_db.session_key(app_db.user_scope())}@local.invalid"})
        _save_login(session_id, service)
        auth_cookies.update("setup", None)
    except Exception:
        SESSIONS.pop(session_id, None)
        service.logout()
        raise HTTPException(status_code=400, detail="The Garmin token could not be verified. Sign in with Garmin again and download a fresh token.") from None
    return {"ready": True}


@app.get("/api/settings/garmin/token")
def download_garmin_token(request: Request, garmin_session: str | None = Cookie(default=None)):
    _settings_access(request, garmin_session)
    service = _get_session(garmin_session)
    return Response(service.export_account()["tokens"], media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="garmin-token.txt"', "Cache-Control": "no-store"})


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
        weight = strava_service.athlete_weight_kg() if day == dt.date.today().isoformat() else None
        return {
            "source": "strava", "bmr": None, "active": None, "workouts": workouts,
            "weightKg": weight, "weightSource": "strava" if weight else None,
        }
    return {"source": "estimate", "bmr": None, "active": None, "workouts": [], "weightKg": None}


def _nutrition_user(garmin_session: str | None) -> str:
    """Name of the logged-in user (Garmin first, else Strava); keys their nutrition log and sheet tabs."""
    _valid_session(garmin_session)
    email = app_db.profile_email()
    if email:
        saved = garmin_auth_store.account_for(email)
        return (saved or {}).get("user") or email
    service = _garmin(garmin_session)
    if service:
        name = getattr(service, "nutrition_user", None)
        if not name:
            try:
                prof = service.profile()
                name = prof.get("fullName") or prof.get("email")
            except Exception:  # noqa: BLE001
                name = service.email
            service.nutrition_user = name  # cache: profile() is a network call
        if name:
            return name
    return strava_service.athlete_name() or "default"


@app.post("/api/nutrition/log")
def nutrition_log(req: NutritionLogRequest, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    day = (req.date or dt.date.today()).isoformat()
    entry = nutrition_service.add_entry(user, req.text, day)
    return {"entry": entry, "day": nutrition_service.assess(user, day, _energy_for(garmin_session, day))}


@app.get("/api/nutrition/day")
def nutrition_day(date: dt.date | None = None, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    day = (date or dt.date.today()).isoformat()
    return {**nutrition_service.assess(user, day, _energy_for(garmin_session, day)), "user": user}


@app.delete("/api/nutrition/entries/{entry_id}")
def nutrition_revoke(
    entry_id: str, item: int | None = None, garmin_session: str | None = Cookie(default=None)
):
    user = _nutrition_user(garmin_session)
    if not nutrition_service.set_revoked(user, entry_id, True, item):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "revoked"}


@app.patch("/api/nutrition/entries/{entry_id}/items/{item}")
def nutrition_item_qty(
    entry_id: str, item: int, req: NutritionQtyRequest, garmin_session: str | None = Cookie(default=None)
):
    user = _nutrition_user(garmin_session)
    if not nutrition_service.set_item_qty(user, entry_id, item, req.qty):
        raise HTTPException(status_code=404, detail="Item not found")
    return {"status": "updated"}


@app.get("/api/nutrition/coach")
def nutrition_coach(date: dt.date | None = None, refresh: bool = False,
                    garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    return nutrition_service.coach(user, (date or dt.date.today()).isoformat(), refresh)


@app.get("/api/nutrition/ideas")
def nutrition_ideas(date: dt.date | None = None, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    return nutrition_service.meal_ideas(user, (date or dt.date.today()).isoformat())


@app.get("/api/nutrition/parser")
def nutrition_parser_status(garmin_session: str | None = Cookie(default=None)):
    _valid_session(garmin_session)
    return food_parser_client.status()


@app.get("/api/nutrition/sheets")
def nutrition_sheets_status(check: bool = False, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    out = {**sheets_sync.status(), "user": user}
    if check and sheets_sync.is_configured():
        out["script"] = sheets_sync.script_info()
    return out


@app.post("/api/nutrition/sheets/sync")
def nutrition_sheets_sync(garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    if not sheets_sync.is_configured():
        raise HTTPException(status_code=400, detail="Google Sheets sync is not configured.")
    return {"user": user, "queued": nutrition_service.sync_all_to_sheets(user)}


@app.post("/api/nutrition/entries/{entry_id}/reanalyse")
def nutrition_reanalyse(entry_id: str, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    if not nutrition_service.reanalyse_entry(user, entry_id):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "reanalysed"}


@app.post("/api/nutrition/entries/{entry_id}/restore")
def nutrition_restore(
    entry_id: str, item: int | None = None, garmin_session: str | None = Cookie(default=None)
):
    user = _nutrition_user(garmin_session)
    if not nutrition_service.set_revoked(user, entry_id, False, item):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "restored"}


@app.get("/api/nutrition/program")
def nutrition_program(garmin_session: str | None = Cookie(default=None)):
    return nutrition_service.programs(_nutrition_user(garmin_session))


@app.post("/api/nutrition/program")
def nutrition_set_program(req: NutritionProgramRequest, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    if req.program not in nutrition_service.PROGRAMS:
        raise HTTPException(status_code=400, detail="Unknown program")
    nutrition_service.set_program(user, req.program, (req.date or dt.date.today()).isoformat())
    return nutrition_service.programs(user)


def _garmin_weight(garmin_session: str | None) -> float | None:
    service = _garmin(garmin_session)
    if not service:
        return None
    try:
        return service.body_weight_kg()
    except Exception:  # noqa: BLE001
        return None


def _nutrition_external_weight(garmin_session: str | None) -> tuple[float | None, str | None]:
    garmin_kg = _garmin_weight(garmin_session)
    if garmin_kg:
        return garmin_kg, "garmin"
    if strava_service.is_connected():
        return strava_service.athlete_weight_kg(), "strava"
    return None, None


@app.get("/api/nutrition/weight")
def nutrition_weight(garmin_session: str | None = Cookie(default=None)):
    weight_kg, source = _nutrition_external_weight(garmin_session)
    return nutrition_service.weights(_nutrition_user(garmin_session), weight_kg, source)


@app.post("/api/nutrition/weight")
def nutrition_set_weight(req: NutritionWeightRequest, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    external_kg, source = _nutrition_external_weight(garmin_session)
    if external_kg:
        provider = "Garmin Connect" if source == "garmin" else "Strava"
        raise HTTPException(status_code=400, detail=f"Weight comes from {provider}; update it there.")
    nutrition_service.set_weight(user, req.kg, (req.date or dt.date.today()).isoformat())
    return nutrition_service.weights(user)


@app.get("/api/nutrition/history")
def nutrition_history(days: int = 30, garmin_session: str | None = Cookie(default=None)):
    user = _nutrition_user(garmin_session)
    days = max(1, min(days, 365))
    return {"days": nutrition_service.history(user, days), "progress": nutrition_service.progress(user, days)}


# ----------------------------------------------------------- static frontend

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    @app.get("/", include_in_schema=False)
    def assistant_home():
        return FileResponse(FRONTEND_DIR / "assistant.html", headers={"Cache-Control": "no-cache"})

    @app.get("/dashboard.html", include_in_schema=False)
    def dashboard_page():
        return FileResponse(FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(app_db.get_setting("app_config", {}).get("port", 8000))
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
