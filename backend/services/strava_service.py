"""
Strava integration for the training portal (extra activity source).

Unlike Garmin (email/password login), Strava uses OAuth2:

  1. The browser is redirected to Strava's authorize page ("Connect Strava").
  2. Strava redirects back to /api/strava/callback with a short-lived `code`.
    3. We exchange that code for SQLite-backed access and refresh tokens.
  4. Access tokens expire (~6h) and are refreshed automatically before use.

You must create a Strava API application at https://www.strava.com/settings/api
to obtain a Client ID and Client Secret. The application owner configures those
once in SQLite; end users only approve consent. Provider tokens are user-specific.

Only activity-level data is available from Strava (no VO2 max, body battery,
readiness, etc. — those remain Garmin-only).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import secrets
import time
from typing import Any

import requests
from backend.utils import app_db, auth_cookies

logger = logging.getLogger("strava.service")

AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
API_BASE = "https://www.strava.com/api/v3"

# Read + activity scope is enough to list activities.
SCOPE = "read,activity:read_all,profile:read_all"

_ACTIVITY_CACHE: dict[tuple[str, int, int | None], tuple[float, list[dict[str, Any]]]] = {}
_ACTIVITY_CACHE_TTL = 60
_ATHLETE_WEIGHT_CACHE: dict[str, tuple[float, float | None]] = {}
_ATHLETE_WEIGHT_CACHE_TTL = 900


# ------------------------------------------------------------------- config


def _load_config() -> dict[str, str]:
    data = app_db.get_setting("strava_app_config", {})
    client_id = str(data.get("client_id") or "").strip()
    client_secret = str(data.get("client_secret") or "").strip()
    if client_id and client_secret:
        return {"client_id": client_id, "client_secret": client_secret}
    return {}


def is_configured() -> bool:
    """Whether Strava API credentials are available."""
    return bool(_load_config())


def yearly_goal_km() -> float | None:
    """User's yearly distance goal (km), from the SQLite settings.

    Strava's API does not expose user goals, so this lets the user pin their
    annual target (e.g. "run 2026 km in 2026") via config.
    """
    value = app_db.user_setting("strava_config", {}).get("yearly_goal_km")
    return float(value) if value is not None else None


# -------------------------------------------------------------- token cache


def _load_tokens() -> dict[str, Any]:
    record = auth_cookies.record("strava")
    return dict(record.get("account") or {}) if record else {}


def _save_tokens(tokens: dict[str, Any], new_session: bool = False) -> None:
    auth_cookies.update("strava", tokens,
                        sid=secrets.token_urlsafe(32) if new_session else None,
                        expires_at=int(time.time()) + auth_cookies.SESSION_LIFETIME if new_session else None)


def is_connected() -> bool:
    """Whether this browser has refreshable Strava tokens."""
    return bool(_load_tokens().get("refresh_token"))


def disconnect() -> None:
    auth_cookies.update("strava", None)


# ---------------------------------------------------------------- oauth flow


def auth_url(redirect_uri: str, state: str, config: dict[str, str] | None = None) -> str:
    """Build the Strava authorize URL to send the browser to."""
    cfg = config or _load_config()
    if not cfg:
        raise RuntimeError("Strava API credentials are not configured.")
    params = {
        "client_id": cfg["client_id"],
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "approval_prompt": "force",
        "scope": SCOPE,
        "state": state,
    }
    query = "&".join(f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in params.items())
    return f"{AUTHORIZE_URL}?{query}"


def exchange_code(code: str, scope: str = "", config: dict[str, str] | None = None) -> None:
    """Exchange an authorization code for access + refresh tokens."""
    cfg = config or _load_config()
    if not cfg:
        raise RuntimeError("Strava API credentials are not configured.")
    resp = requests.post(
        TOKEN_URL,
        data={
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()
    athlete = data.get("athlete") or {}
    _save_tokens(
        {
            "access_token": data["access_token"],
            "refresh_token": data["refresh_token"],
            "expires_at": data["expires_at"],
            "scope": scope,
            "client_config": cfg,
            "athlete": {key: athlete.get(key) for key in ("id", "firstname", "lastname", "profile_medium", "profile")},
        },
        new_session=True,
    )
    auth_cookies.update("setup", None)


def _valid_access_token() -> str:
    """Return a currently-valid access token, refreshing if needed."""
    tokens = _load_tokens()
    if not tokens.get("refresh_token"):
        raise RuntimeError("Strava is not connected.")

    # Refresh if the token expires within the next minute.
    if tokens.get("expires_at", 0) - 60 <= time.time():
        cfg = _load_config()
        issued = tokens.get("client_config") or {}
        if issued and cfg.get("client_id") != issued.get("client_id"):
            cfg = issued
        if not cfg:
            raise RuntimeError("Strava API credentials are not configured.")
        resp = requests.post(
            TOKEN_URL,
            data={
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "refresh_token": tokens["refresh_token"],
                "grant_type": "refresh_token",
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        tokens.update(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=data["expires_at"],
        )
        _save_tokens(tokens)

    return tokens["access_token"]


# ------------------------------------------------------------------- data


def athlete_name() -> str | None:
    """Best-effort display name of the connected Strava athlete."""
    athlete = _load_tokens().get("athlete") or {}
    first = athlete.get("firstname") or ""
    last = athlete.get("lastname") or ""
    name = f"{first} {last}".strip()
    return name or None


def athlete_weight_kg() -> float | None:
    """Return the connected Strava athlete's profile weight in kg, cached briefly."""
    if not is_connected():
        return None
    record = auth_cookies.record("strava")
    if record is None:
        return None
    cache_key = record["sid"]
    cached_at, cached_weight = _ATHLETE_WEIGHT_CACHE.get(cache_key, (0.0, None))
    if time.time() - cached_at < _ATHLETE_WEIGHT_CACHE_TTL:
        return cached_weight
    try:
        token = _valid_access_token()
        response = requests.get(f"{API_BASE}/athlete", headers={"Authorization": f"Bearer {token}"}, timeout=20)
        response.raise_for_status()
        raw = response.json().get("weight")
        weight = float(raw) if raw else None
        if weight is not None and not 25 <= weight <= 350:
            weight = None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Strava athlete weight fetch failed: %s", exc)
        weight = None
    _ATHLETE_WEIGHT_CACHE[cache_key] = (time.time(), round(weight, 1) if weight else None)
    return _ATHLETE_WEIGHT_CACHE[cache_key][1]


def athlete_avatar() -> str | None:
    """Profile picture URL of the connected Strava athlete, if any."""
    athlete = _load_tokens().get("athlete") or {}
    url = athlete.get("profile_medium") or athlete.get("profile")
    if url and str(url).startswith("http"):
        return url
    return None


def status() -> dict[str, Any]:
    """Connection status for the frontend."""
    return {
        "configured": is_configured(),
        "connected": is_connected(),
        "athlete": athlete_name(),
        "avatar": athlete_avatar(),
        "yearlyGoalKm": yearly_goal_km(),
    }


def activities(limit: int = 50, days: int | None = None) -> list[dict[str, Any]]:
    """Fetch and normalize recent Strava activities (Garmin-compatible shape).

    Pages newest-first (Strava's default order). When ``days`` is given, it keeps
    paging until it reaches an activity older than the window, returning every
    activity inside it; otherwise it stops once ``limit`` items are collected.
    """
    record = auth_cookies.record("strava")
    if not record or not is_connected():
        raise RuntimeError("Strava is not connected.")
    cache_key = (record["sid"], limit, days)
    cached = _ACTIVITY_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < _ACTIVITY_CACHE_TTL:
        return cached[1]

    token = _valid_access_token()
    headers = {"Authorization": f"Bearer {token}"}

    cutoff_ts: float | None = None
    if days is not None:
        cutoff_ts = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
        ).timestamp()

    per_page = 100
    page = 1
    max_items = 400 if days is not None else max(limit, 1)
    collected: list[dict[str, Any]] = []
    stop = False

    while not stop and len(collected) < max_items and page <= 30:
        resp = requests.get(
            f"{API_BASE}/athlete/activities",
            headers=headers,
            params={"per_page": per_page, "page": page},
            timeout=20,
        )
        if resp.status_code == 429:
            if cached:
                logger.warning("Strava rate limit reached; returning cached activities")
                return cached[1]
            resp.raise_for_status()
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break

        for a in batch:
            if cutoff_ts is not None:
                sd = a.get("start_date")
                if sd:
                    try:
                        ts = dt.datetime.fromisoformat(
                            sd.replace("Z", "+00:00")
                        ).timestamp()
                    except ValueError:
                        ts = None
                    if ts is not None and ts < cutoff_ts:
                        stop = True
                        break
            collected.append(a)
            if len(collected) >= max_items:
                break

        if len(batch) < per_page:
            break
        page += 1

    if days is None:
        collected = collected[:limit]
    normalized = [_normalize(a) for a in collected]
    _ACTIVITY_CACHE[cache_key] = (time.time(), normalized)
    return normalized


def running_activities(days: int = 365) -> list[dict[str, Any]]:
    """Return running-type efforts as [{date, meters, seconds}] for the window.

    Used to fold Strava into the year projection and race prediction. Returns an
    empty list if Strava is not connected or the fetch fails.
    """
    if not is_connected():
        return []
    try:
        acts = activities(limit=200, days=days)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not load Strava running activities: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for a in acts:
        if a.get("type") not in ("running", "trail_running"):
            continue
        km = a.get("distanceKm") or 0
        if km <= 0:
            continue
        out.append(
            {
                "date": (a.get("startTime") or "")[:10],
                "meters": km * 1000,
                "seconds": a.get("durationSec") or 0,
            }
        )
    return out


def gear() -> dict[str, Any]:
    """Return the active shoe plus all shoes (incl. retired) with mileage.

    The "active" shoe is the one used most across the last ~10 activities (more
    reliable than Strava's primary flag, which is often unset). Gear is gathered
    both from the athlete profile and from the ``gear_id`` on recent activities.
    """
    token = _valid_access_token()
    headers = {"Authorization": f"Bearer {token}"}

    gear_by_id: dict[str, dict[str, Any]] = {}

    def add(g: dict[str, Any]) -> None:
        gid = g.get("id")
        if not gid or g.get("frame_type") is not None:  # skip bikes
            return
        gear_by_id[gid] = {
            "id": gid,
            "name": g.get("name") or g.get("nickname") or "Shoe",
            "km": round((g.get("distance") or 0) / 1000, 1),
            "primary": bool(g.get("primary")),
            "retired": bool(g.get("retired")),
        }

    # 1) Shoes from the athlete profile.
    try:
        resp = requests.get(f"{API_BASE}/athlete", headers=headers, timeout=20)
        resp.raise_for_status()
        for s in resp.json().get("shoes") or []:
            add(s)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Strava /athlete gear fetch failed: %s", exc)

    # 2) Shoe gear ids referenced by recent activities, most-recent first.
    recent_shoe_ids: list[str] = []
    try:
        resp = requests.get(
            f"{API_BASE}/athlete/activities",
            headers=headers,
            params={"per_page": 100, "page": 1},
            timeout=20,
        )
        resp.raise_for_status()
        for a in resp.json():
            gid = a.get("gear_id")
            if gid and str(gid).startswith("g"):  # 'g' = shoes, 'b' = bikes
                recent_shoe_ids.append(gid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Strava activity gear scan failed: %s", exc)

    for gid in dict.fromkeys(recent_shoe_ids):
        if gid not in gear_by_id:
            try:
                resp = requests.get(f"{API_BASE}/gear/{gid}", headers=headers, timeout=20)
                resp.raise_for_status()
                add(resp.json())
            except Exception as exc:  # noqa: BLE001
                logger.warning("Strava /gear/%s fetch failed: %s", gid, exc)

    shoes = list(gear_by_id.values())
    shoes.sort(key=lambda s: (s["retired"], -s["km"]))

    # Active = most-used shoe over the last 10 activities.
    active = None
    last10 = [g for g in recent_shoe_ids[:10]]
    if last10:
        from collections import Counter

        for gid, _ in Counter(last10).most_common():
            if gid in gear_by_id and not gear_by_id[gid]["retired"]:
                active = gear_by_id[gid]
                break
    if not active:
        active = next((s for s in shoes if s["primary"] and not s["retired"]), None)
    if not active:
        active = next((s for s in shoes if not s["retired"]), None)

    return {"active": active, "shoes": shoes}


def week_streak() -> dict[str, Any]:
    """Consecutive-week run streak (weeks with >=1 run, ending at the latest)."""
    acts = running_activities(days=400)
    weeks: set[dt.date] = set()
    for a in acts:
        try:
            d = dt.date.fromisoformat(str(a.get("date"))[:10])
        except (ValueError, TypeError):
            continue
        weeks.add(d - dt.timedelta(days=d.weekday()))

    if not weeks:
        return {"weeks": 0, "thisWeekActive": False}

    today = dt.date.today()
    current = today - dt.timedelta(days=today.weekday())
    this_active = current in weeks

    streak = 0
    w = current if this_active else current - dt.timedelta(weeks=1)
    while w in weeks:
        streak += 1
        w -= dt.timedelta(weeks=1)

    return {"weeks": streak, "thisWeekActive": this_active}


def extras() -> dict[str, Any]:
    """Bundle gear + streak for the dashboard tiles (best-effort)."""
    result: dict[str, Any] = {"gear": None, "streak": None}
    try:
        result["gear"] = gear()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not load Strava gear: %s", exc)
    try:
        result["streak"] = week_streak()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not load Strava streak: %s", exc)
    return result


# --------------------------------------------------------------- normalize

# Map Strava sport types onto the typeKey vocabulary the frontend already uses.
_TYPE_MAP = {
    "Run": "running",
    "TrailRun": "trail_running",
    "Ride": "cycling",
    "VirtualRide": "cycling",
    "VirtualRun": "running",
    "Walk": "walking",
    "Hike": "hiking",
    "Swim": "lap_swimming",
    "Workout": "fitness_equipment",
}


def _normalize(a: dict[str, Any]) -> dict[str, Any]:
    """Flatten a Strava activity into the portal's common activity shape."""
    sport = a.get("sport_type") or a.get("type") or "Workout"
    type_key = _TYPE_MAP.get(sport, str(sport).lower())

    distance_m = a.get("distance") or 0
    duration_s = a.get("moving_time") or a.get("elapsed_time") or 0
    avg_speed = a.get("average_speed") or 0  # meters/second

    pace_min_per_km = None
    if avg_speed and avg_speed > 0:
        pace_min_per_km = (1000 / avg_speed) / 60

    # Strava run cadence is single-leg strides/min; double it for steps/min.
    cadence = a.get("average_cadence")
    if cadence and type_key in ("running", "trail_running"):
        cadence = round(cadence * 2)

    start_local = a.get("start_date_local")  # e.g. 2026-07-10T06:15:00Z
    if start_local:
        start_local = start_local.replace("T", " ").replace("Z", "")

    # Strava tags each activity with a workout_type. For runs: 1=Race,
    # 2=Long Run, 3=Workout; for rides: 11=Race, 12=Workout. Expose it as a
    # simple tag so the UI can filter races / long runs.
    workout_type = a.get("workout_type")
    tag = None
    if workout_type is not None:
        if type_key in ("cycling", "road_biking", "indoor_cycling"):
            tag = {11: "race", 12: "workout"}.get(int(workout_type))
        else:
            tag = {1: "race", 2: "long_run", 3: "workout"}.get(int(workout_type))

    return {
        "activityId": f"strava-{a.get('id')}",
        "stravaId": a.get("id"),
        "source": "strava",
        "name": a.get("name"),
        "type": type_key,
        "startTime": start_local,
        "distanceKm": round(distance_m / 1000, 2),
        "durationSec": duration_s,
        "calories": a.get("calories"),
        "averageHR": round(a["average_heartrate"]) if a.get("average_heartrate") else None,
        "maxHR": round(a["max_heartrate"]) if a.get("max_heartrate") else None,
        "paceMinPerKm": round(pace_min_per_km, 2) if pace_min_per_km else None,
        "averageSpeed": avg_speed,
        "elevationGain": a.get("total_elevation_gain"),
        "vo2Max": None,
        "averageCadence": cadence,
        "aerobicTrainingEffect": None,
        "anaerobicTrainingEffect": None,
        "hasIntervals": bool(a.get("workout_type") == 3),  # 3 = "Workout" for runs
        "tag": tag,
        "benefit": None,
    }
