"""
Thin wrapper around the `garminconnect` library.

Handles login (including MFA), token caching to disk so the app does not have to
re-authenticate on every restart, and provides convenience methods to fetch the
training / wellness data the portal displays.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import queue
import statistics
import threading
from typing import Any

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

logger = logging.getLogger("garmin.service")

# Folder where Garth stores the OAuth1/OAuth2 tokens after a successful login.
TOKEN_STORE = os.environ.get(
    "GARMIN_TOKENSTORE",
    os.path.join(os.path.expanduser("~"), ".garmin_portal_tokens"),
)


class GarminService:
    """Holds an authenticated Garmin client and exposes data helpers."""

    def __init__(self) -> None:
        self.client: Garmin | None = None
        self.email: str | None = None

        # The garminconnect login is synchronous and asks for the MFA code via a
        # `prompt_mfa` callback. To make that work in a web flow we run login in a
        # background thread; the callback blocks on a queue until the user submits
        # the code through the /api/mfa endpoint.
        self._login_thread: threading.Thread | None = None
        self._mfa_queue: queue.Queue[str] = queue.Queue(maxsize=1)
        self._mfa_needed = threading.Event()
        self._login_done = threading.Event()
        self._login_error: Exception | None = None
        self._ready = False

    # ------------------------------------------------------------------ auth

    @property
    def is_authenticated(self) -> bool:
        return self._ready and self.client is not None

    def _prompt_mfa(self) -> str:
        """Called by garth when an MFA code is required (runs in login thread)."""
        self._mfa_needed.set()
        return self._mfa_queue.get()  # blocks until submit_mfa() provides a code

    def _run_login(self) -> None:
        try:
            assert self.client is not None
            self.client.login()
            self._ready = True
        except Exception as exc:  # noqa: BLE001 - reported back to the caller
            self._login_error = exc
        finally:
            self._login_done.set()

    def login(self, email: str, password: str) -> str:
        """Start a login.

        Returns:
            "success" if logged in, or "mfa_required" if a code is needed.
        """
        self.email = email
        self._login_error = None
        self._ready = False
        self._mfa_needed.clear()
        self._login_done.clear()

        self.client = Garmin(email=email, password=password, prompt_mfa=self._prompt_mfa)
        self._login_thread = threading.Thread(target=self._run_login, daemon=True)
        self._login_thread.start()

        # Wait until either login finishes or an MFA code is requested.
        while not self._login_done.wait(timeout=0.1):
            if self._mfa_needed.is_set():
                return "mfa_required"

        if self._login_error is not None:
            raise self._login_error
        self._persist_tokens()
        return "success"

    def submit_mfa(self, code: str) -> str:
        """Finish a login that required a multi-factor authentication code."""
        if self._login_thread is None or not self._mfa_needed.is_set():
            raise RuntimeError("No pending MFA login. Please start over.")

        self._mfa_queue.put(code)
        self._login_done.wait(timeout=60)

        if self._login_error is not None:
            raise self._login_error
        if not self._ready:
            raise RuntimeError("Login did not complete")
        self._persist_tokens()
        return "success"

    def login_from_cache(self) -> bool:
        """Try to restore a session from previously saved tokens."""
        try:
            garmin = Garmin()
            garmin.login(TOKEN_STORE)
            self.client = garmin
            self._ready = True
            return True
        except Exception:  # noqa: BLE001 - any failure means "not cached"
            return False

    def logout(self) -> None:
        self.client = None
        self._ready = False
        self._mfa_needed.clear()
        self._login_done.clear()

    def _persist_tokens(self) -> None:
        try:
            if self.client is not None:
                self.client.garth.dump(TOKEN_STORE)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not persist Garmin tokens: %s", exc)

    # ------------------------------------------------------------------ data

    def _require_client(self) -> Garmin:
        if self.client is None:
            raise RuntimeError("Not authenticated")
        return self.client

    def profile(self) -> dict[str, Any]:
        client = self._require_client()
        full_name = _safe(client.get_full_name)
        return {
            "fullName": full_name,
            "email": self.email,
        }

    def daily_stats(self, date: str) -> dict[str, Any]:
        client = self._require_client()
        return _safe(client.get_stats, date) or {}

    def vo2max(self, date: str) -> dict[str, Any]:
        """Return running & cycling VO2 max for the given date."""
        client = self._require_client()
        data = _safe(client.get_max_metrics, date) or []
        generic = None
        cycling = None
        if isinstance(data, list) and data:
            entry = data[0]
            generic = (entry.get("generic") or {}).get("vo2MaxValue")
            cycling = (entry.get("cycling") or {}).get("vo2MaxValue")
        return {"runningVo2Max": generic, "cyclingVo2Max": cycling}

    def vo2max_history(self, start: str, end: str) -> list[dict[str, Any]]:
        """Return the daily VO2 max series between two dates (inclusive).

        The Garmin maxmet endpoint accepts a date range, so the whole trend is
        fetched in a single request. Days without a recorded value are omitted.
        """
        client = self._require_client()
        url = f"/metrics-service/metrics/maxmet/daily/{start}/{end}"
        data = _safe(client.connectapi, url) or []
        points: list[dict[str, Any]] = []
        for entry in data if isinstance(data, list) else []:
            generic = entry.get("generic") or {}
            cycling = entry.get("cycling") or {}
            date = (
                entry.get("calendarDate")
                or generic.get("calendarDate")
                or cycling.get("calendarDate")
            )
            running_val = generic.get("vo2MaxValue")
            cycling_val = cycling.get("vo2MaxValue")
            if date and (running_val is not None or cycling_val is not None):
                points.append(
                    {"date": date, "running": running_val, "cycling": cycling_val}
                )
        points.sort(key=lambda p: p["date"])
        return points

    def training_status(self, date: str) -> dict[str, Any]:
        client = self._require_client()
        return _safe(client.get_training_status, date) or {}

    def hrv(self, date: str) -> dict[str, Any]:
        client = self._require_client()
        return _safe(client.get_hrv_data, date) or {}

    def activities(
        self, limit: int = 50, days: int | None = None,
        start: str | None = None, end: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return activities for an explicit date range, last `days`, or last `limit`."""
        client = self._require_client()
        if start and end:
            raw = _safe(client.get_activities_by_date, start, end) or []
        elif days:
            today = dt.date.today()
            start_d = today - dt.timedelta(days=days)
            raw = (
                _safe(
                    client.get_activities_by_date,
                    start_d.isoformat(),
                    today.isoformat(),
                )
                or []
            )
        else:
            raw = _safe(client.get_activities, 0, limit) or []

        acts = [_normalize_activity(a) for a in raw]
        acts.sort(key=lambda a: a.get("startTime") or "", reverse=True)
        return acts

    def running_only_cadence(self, activity_id: str) -> float | None:
        """Distance-weighted cadence over the run-detection (RWD_RUN) splits.

        Excludes walk/stand segments, which otherwise drag the whole-activity
        average cadence down for run/walk sessions.
        """
        client = self._require_client()
        ts = _safe(client.get_activity_typed_splits, activity_id) or {}
        runs = [s for s in (ts.get("splits") or []) if s.get("type") == "RWD_RUN"]
        num = sum(
            (s.get("averageRunCadence") or 0) * (s.get("distance") or 0)
            for s in runs
            if s.get("averageRunCadence") and s.get("distance")
        )
        den = sum(
            (s.get("distance") or 0)
            for s in runs
            if s.get("averageRunCadence") and s.get("distance")
        )
        return round(num / den, 1) if den else None

    def activity_detail(self, activity_id: str) -> dict[str, Any]:
        client = self._require_client()
        raw = _safe(client.get_activity, activity_id) or {}
        summary = raw.get("summaryDTO") or {}
        type_dto = raw.get("activityTypeDTO") or {}
        metadata = raw.get("metadataDTO") or {}
        device = (metadata.get("deviceMetaDataDTO") or {}) if isinstance(
            metadata, dict
        ) else {}

        # The whole-activity average cadence is dragged down by walk/stand time
        # in run/walk & interval sessions. If it looks contaminated (well below a
        # normal running cadence), replace it with the run-only cadence.
        type_key = type_dto.get("typeKey") or ""
        cad = summary.get("averageRunCadence")
        if "running" in type_key and (cad is None or cad < 150):
            rc = self.running_only_cadence(activity_id)
            if rc:
                summary["averageRunCadence"] = rc

        return {
            "activityId": raw.get("activityId"),
            "name": raw.get("activityName"),
            "type": type_dto.get("typeKey"),
            "typeParent": type_dto.get("parentTypeId"),
            "location": raw.get("locationName"),
            "manufacturer": metadata.get("manufacturer"),
            "lapCount": metadata.get("lapCount"),
            "personalRecord": metadata.get("personalRecord"),
            "favorite": metadata.get("favorite"),
            "summary": summary,
        }

    def compare_activity(self, activity_id: str) -> dict[str, Any]:
        """Find the best previous activity to compare against.

        Interval workouts are matched to other interval workouts with a similar
        pattern (number and distances of the work intervals); plain runs are
        matched to other plain runs by closest total distance.
        """
        client = self._require_client()
        raw = _safe(client.get_activities, 0, 100) or []
        acts = [_normalize_activity(a) for a in raw]

        current = next(
            (a for a in acts if str(a["activityId"]) == str(activity_id)), None
        )
        if current is None:
            # Activity not in the recent list — rebuild it from its detail.
            detail = self.activity_detail(activity_id)
            s = detail.get("summary") or {}
            speed = s.get("averageSpeed") or 0
            current = {
                "activityId": detail.get("activityId"),
                "name": detail.get("name"),
                "type": detail.get("type"),
                "startTime": s.get("startTimeLocal"),
                "distanceKm": round((s.get("distance") or 0) / 1000, 2),
                "durationSec": s.get("duration"),
                "paceMinPerKm": round((1000 / speed) / 60, 2) if speed else None,
                "averageHR": s.get("averageHR"),
                "maxHR": s.get("maxHR"),
                "calories": s.get("calories"),
                "hasIntervals": self.activity_laps(activity_id).get("isInterval"),
            }

        if not current or not current.get("distanceKm"):
            return {
                "current": current,
                "previous": None,
                "message": "No distance data available to compare.",
            }

        ctype = current.get("type")
        cdist = current.get("distanceKm")
        ctime = current.get("startTime") or ""
        is_interval = bool(current.get("hasIntervals"))

        # ----- Interval workout: match by interval pattern -----
        if is_interval:
            candidates = [
                a
                for a in acts
                if str(a["activityId"]) != str(activity_id)
                and a.get("type") == ctype
                and a.get("hasIntervals")
                and a.get("distanceKm")
            ]
            older = [a for a in candidates if (a.get("startTime") or "") < ctime]
            pool = older or candidates
            if not pool:
                return {
                    "current": current,
                    "previous": None,
                    "message": "No previous interval workout to compare with.",
                }

            cur_sig = self._interval_signature(activity_id)
            best = None
            best_score = float("inf")
            for a in pool:
                sig = self._interval_signature(a["activityId"])
                score = _interval_similarity(cur_sig, sig)
                if score < best_score:
                    best_score = score
                    best = a

            note = "Matched by interval pattern"
            if cur_sig["count"]:
                avg = round(sum(cur_sig["distances"]) / cur_sig["count"], 2)
                note = f"Matched by interval pattern · {cur_sig['count']} × ~{avg} km"
            return {
                "current": current,
                "previous": best,
                "message": None,
                "matchNote": note,
            }

        # ----- Plain run: match by closest total distance -----
        candidates = [
            a
            for a in acts
            if str(a["activityId"]) != str(activity_id)
            and a.get("type") == ctype
            and a.get("distanceKm")
            and not a.get("hasIntervals")
        ]
        older = [a for a in candidates if (a.get("startTime") or "") < ctime]
        pool = older or candidates

        if not pool:
            return {
                "current": current,
                "previous": None,
                "message": "No previous activity of the same type to compare with.",
            }

        previous = min(pool, key=lambda a: abs(a["distanceKm"] - cdist))
        return {
            "current": current,
            "previous": previous,
            "message": None,
            "matchNote": "Matched by closest distance",
        }

    def _interval_signature(self, activity_id: str) -> dict[str, Any]:
        """Summarise an interval workout's structure for pattern matching."""
        data = self.activity_laps(str(activity_id))
        laps = data.get("laps") or []
        work = [l for l in laps if l.get("phase") in ("Run", "Active")]
        if not work:
            work = laps
        distances = sorted(round(l.get("distanceKm") or 0, 2) for l in work)
        total = round(sum((l.get("distanceKm") or 0) for l in laps), 2)
        return {"count": len(work), "distances": distances, "total": total}

    def activity_laps(self, activity_id: str) -> dict[str, Any]:
        """Return per-lap (split) data for an activity.

        Detects structured interval workouts (which carry warm-up / recovery /
        rest / cool-down phases) versus plain runs that only have distance laps.
        """
        client = self._require_client()
        data = _safe(client.get_activity_splits, activity_id) or {}
        laps_raw = data.get("lapDTOs") or [] if isinstance(data, dict) else []
        laps: list[dict[str, Any]] = []
        for lap in laps_raw:
            speed = lap.get("averageSpeed") or 0
            intensity = lap.get("intensityType")
            laps.append(
                {
                    "lapIndex": lap.get("lapIndex"),
                    "distanceKm": round((lap.get("distance") or 0) / 1000, 3),
                    "durationSec": lap.get("duration"),
                    "paceMinPerKm": round((1000 / speed) / 60, 2) if speed else None,
                    "averageSpeed": speed,
                    "averageHR": lap.get("averageHR"),
                    "maxHR": lap.get("maxHR"),
                    "averageRunCadence": lap.get("averageRunCadence"),
                    "elevationGain": lap.get("elevationGain"),
                    "calories": lap.get("calories"),
                    "intensityType": intensity,
                    "phase": _phase_label(intensity),
                }
            )

        # A structured interval workout has explicit warm-up / recovery / rest /
        # cool-down phases; a plain run only carries generic "active" laps.
        phase_types = {
            (lap.get("intensityType") or "").upper() for lap in laps_raw
        }
        structured_types = {"WARMUP", "COOLDOWN", "RECOVERY", "REST", "ACTIVE"}
        is_interval = bool(phase_types & structured_types)

        # Fallback: many self-made interval sessions record every lap as generic
        # "INTERVAL". Infer Interval vs Recovery from the pace pattern so the user
        # can still filter the fast reps from the slow jogs. Only do this when the
        # laps are genuinely bimodal (several fast + several slow, with a clear
        # gap) so steady/progression runs aren't misclassified.
        if not is_interval:
            paces = [l["paceMinPerKm"] for l in laps if l["paceMinPerKm"]]
            if len(paces) >= 5 and (max(paces) - min(paces)) >= 1.5:
                # The interval reps cluster at the fast end; the first clear jump
                # in the sorted paces marks the boundary to the recovery jogs/walks.
                # (A plain midpoint gets skewed by very slow standing laps.)
                sp = sorted(paces)
                cutoff = None
                for i in range(len(sp) - 1):
                    if sp[i + 1] - sp[i] >= 1.5:
                        cutoff = (sp[i] + sp[i + 1]) / 2
                        break
                if cutoff is not None:
                    cutoff = min(cutoff, 9.0)  # never call slower than 9:00/km an interval
                    fast = [p for p in paces if p <= cutoff]
                    slow = [p for p in paces if p > cutoff]
                    if len(fast) >= 3 and len(slow) >= 2:
                        for l in laps:
                            p = l["paceMinPerKm"]
                            if p is None:
                                l["phase"] = None
                            elif p <= cutoff:
                                l["phase"] = "Interval"
                            else:
                                l["phase"] = "Recovery"
                        is_interval = True

        return {
            "isInterval": is_interval,
            "workoutType": "Interval" if is_interval else "Laps",
            "laps": laps,
        }

    def running_report(self) -> dict[str, Any]:
        """Total running distance for the current year and month.

        Includes a per-month breakdown for the year so the dashboard can chart
        it. Covers the whole running family (road, treadmill, trail, indoor).
        """
        client = self._require_client()
        today = dt.date.today()
        year_start = dt.date(today.year, 1, 1)
        month_start = dt.date(today.year, today.month, 1)
        current_week = today - dt.timedelta(days=today.weekday())
        weekly_start = current_week - dt.timedelta(weeks=11)
        fetch_start = min(year_start, weekly_start)

        acts = (
            _safe(
                client.get_activities_by_date,
                fetch_start.isoformat(),
                today.isoformat(),
            )
            or []
        )

        from collections import defaultdict

        monthly_m = [0.0] * 12
        week_m: dict[dt.date, float] = defaultdict(float)
        year_m = 0.0
        year_count = 0
        month_m = 0.0
        month_count = 0
        recent60_m = 0.0

        for a in acts:
            type_key = (a.get("activityType") or {}).get("typeKey", "")
            if "running" not in type_key:
                continue
            distance = a.get("distance") or 0
            start = a.get("startTimeLocal") or ""
            try:
                a_date = dt.date.fromisoformat(start[:10])
            except ValueError:
                continue

            week_start = a_date - dt.timedelta(days=a_date.weekday())
            week_m[week_start] += distance
            if a_date >= today - dt.timedelta(days=60):
                recent60_m += distance

            if a_date < year_start:
                continue

            year_m += distance
            year_count += 1
            monthly_m[a_date.month - 1] += distance
            if a_date >= month_start:
                month_m += distance
                month_count += 1

        month_names = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ]

        weekly = [
            {
                "week": (current_week - dt.timedelta(weeks=i)).strftime("%b %d"),
                "weekStart": (current_week - dt.timedelta(weeks=i)).isoformat(),
                "km": round(
                    week_m.get(current_week - dt.timedelta(weeks=i), 0) / 1000, 1
                ),
            }
            for i in range(11, -1, -1)
        ]

        # ----- Weekly mileage progress vs a "normal" baseline -----
        current_km = weekly[-1]["km"]
        prev_weeks = [w["km"] for w in weekly[:-1]]  # completed weeks, oldest→newest
        # Use the most recent 4 "normal" weeks (skip near-zero / injury/rest weeks).
        median_prev = statistics.median(prev_weeks) if prev_weeks else 0
        floor = max(median_prev * 0.4, 10)
        normal = [k for k in prev_weeks if k >= floor]
        baseline_weeks = (normal or prev_weeks)[-4:]
        avg4 = sum(baseline_weeks) / len(baseline_weeks) if baseline_weeks else 0
        target = round(avg4 / 10) * 10  # nearest 10 km
        days_elapsed = today.weekday() + 1  # Mon=1 … today
        expected_so_far = round(target * days_elapsed / 7, 1)
        remaining = round(max(target - current_km, 0), 1)
        deviation = round(current_km - expected_so_far, 1)
        if target == 0:
            wp_status = "No baseline yet — keep logging runs."
        elif deviation >= 2:
            wp_status = f"Ahead of pace by {deviation:.0f} km — great consistency."
        elif deviation <= -5:
            wp_status = f"Behind by {abs(deviation):.0f} km — {remaining:.0f} km left to hit {target} km this week."
        else:
            wp_status = f"On track — {remaining:.0f} km left to reach {target} km this week."

        weekly_progress = {
            "currentKm": round(current_km, 1),
            "targetKm": target,
            "avg4Km": round(avg4, 1),
            "remainingKm": remaining,
            "expectedSoFarKm": expected_so_far,
            "deviationKm": deviation,
            "daysElapsed": days_elapsed,
            "baselineWeeks": [round(k, 1) for k in baseline_weeks],
            "status": wp_status,
            "weekStart": current_week.isoformat(),
        }

        return {
            "year": {
                "label": str(today.year),
                "km": round(year_m / 1000, 1),
                "count": year_count,
            },
            "month": {
                "label": today.strftime("%B %Y"),
                "km": round(month_m / 1000, 1),
                "count": month_count,
            },
            "monthly": [
                {"month": month_names[i], "km": round(monthly_m[i] / 1000, 1)}
                for i in range(12)
            ],
            "weekly": weekly,
            "weeklyProgress": weekly_progress,
            "projection": self._year_projection(today, year_m, recent60_m),
        }

    def _year_projection(
        self, today: dt.date, year_m: float, recent60_m: float
    ) -> dict[str, Any]:
        """Project year-end running distance.

        Projects the remaining days of the year at the runner's recent 60-day
        pace (rather than the whole-year average), so the estimate reflects
        current training level. Blended 70/30 with the year-to-date run-rate to
        temper an unusually hot or quiet recent spell.
        """
        import calendar

        ytd_km = year_m / 1000
        day_of_year = today.timetuple().tm_yday
        days_in_year = 366 if calendar.isleap(today.year) else 365
        remaining = days_in_year - day_of_year

        recent_window = min(60, day_of_year)
        recent_daily = (recent60_m / 1000) / recent_window if recent_window else 0
        ytd_daily = ytd_km / day_of_year if day_of_year else 0

        # Blend recent pace (70%) with year-to-date pace (30%).
        blended_daily = 0.7 * recent_daily + 0.3 * ytd_daily
        projected = round(ytd_km + remaining * blended_daily)

        return {
            "projectedKm": projected,
            "ytdKm": round(ytd_km, 1),
            "remainingDays": remaining,
            "recentPacePerWeek": round(recent_daily * 7, 1),
            "onPacePerMonth": round(blended_daily * 30, 1),
        }

    def training_guidance(self) -> dict[str, Any]:
        """Overall training-status coach.

        Synthesises training-load (ACWR), easy/hard balance, volume trend and
        recovery into a single verdict that tells the runner whether they are
        overreaching (injury risk), undertraining, or progressing well.
        """
        client = self._require_client()
        today = dt.date.today()
        start = today - dt.timedelta(days=90)
        acts = (
            _safe(
                client.get_activities_by_date,
                start.isoformat(),
                today.isoformat(),
                "running",
            )
            or []
        )

        def a_date(a: dict[str, Any]) -> dt.date | None:
            try:
                return dt.date.fromisoformat((a.get("startTimeLocal") or "")[:10])
            except ValueError:
                return None

        # --- Training-load ACWR ---
        load7 = sum(
            (a.get("activityTrainingLoad") or 0)
            for a in acts
            if (d := a_date(a)) and d >= today - dt.timedelta(days=7)
        )
        load28 = sum(
            (a.get("activityTrainingLoad") or 0)
            for a in acts
            if (d := a_date(a)) and d >= today - dt.timedelta(days=28)
        )
        chronic = load28 / 4
        acwr = round(load7 / chronic, 2) if chronic > 0 else None

        # --- Easy/hard balance (Z1–2) over last 28 days ---
        z = [0.0] * 5
        for a in acts:
            d = a_date(a)
            if d and d >= today - dt.timedelta(days=28):
                for i in range(5):
                    z[i] += a.get(f"hrTimeInZone_{i + 1}") or 0
        ztotal = sum(z)
        easy_pct = round((z[0] + z[1]) / ztotal * 100, 1) if ztotal else None

        # --- Volume trend: last 7 days vs prior 3-week average ---
        last7_km = sum(
            (a.get("distance") or 0)
            for a in acts
            if (d := a_date(a)) and d >= today - dt.timedelta(days=7)
        ) / 1000
        prior_km = sum(
            (a.get("distance") or 0)
            for a in acts
            if (d := a_date(a))
            and today - dt.timedelta(days=28) <= d < today - dt.timedelta(days=7)
        ) / 1000
        prior_week_avg = prior_km / 3 if prior_km else 0
        vol_ratio = (last7_km / prior_week_avg) if prior_week_avg > 0 else None

        # --- Recovery from today's wellness stats ---
        stats = self.daily_stats(today.isoformat())
        bb = stats.get("bodyBatteryHighestValue")
        sleep_h = (stats.get("sleepingSeconds") or 0) / 3600 or None

        # ---------- Build signals ----------
        signals: list[dict[str, Any]] = []

        if acwr is not None:
            if acwr > 1.5:
                lv, txt = "watch", "Load has spiked well above your baseline — high injury risk."
            elif acwr > 1.3:
                lv, txt = "ok", "Ramping up quickly — monitor fatigue and don't add much more."
            elif acwr >= 0.8:
                lv, txt = "good", "In the safe progression sweet spot (0.8–1.3)."
            elif acwr >= 0.5:
                lv, txt = "ok", "Below your baseline — fine for recovery, or build up gradually."
            else:
                lv, txt = "ok", "Well below baseline — you're detraining or tapering."
            signals.append({"label": "Training load (ACWR)", "value": f"{acwr}", "level": lv, "text": txt})

        if easy_pct is not None:
            if easy_pct >= 70:
                lv, txt = "good", f"{easy_pct:.0f}% easy — a healthy aerobic base."
            elif easy_pct >= 55:
                lv, txt = "ok", f"{easy_pct:.0f}% easy — a bit more easy running would help."
            else:
                lv, txt = "watch", f"Only {easy_pct:.0f}% easy — too much hard running risks burnout/plateau."
            signals.append({"label": "Easy/hard balance", "value": f"{easy_pct:.0f}% easy", "level": lv, "text": txt})

        if vol_ratio is not None:
            pct = round((vol_ratio - 1) * 100)
            if vol_ratio > 1.4:
                lv, txt = "watch", f"Weekly volume jumped {pct:+d}% vs recent average — ramp more gradually (~10%/week)."
            elif vol_ratio < 0.6:
                lv, txt = "ok", f"Volume down {pct:+d}% — a cutback/taper, or a dip to watch."
            else:
                lv, txt = "good", "Volume is steady and consistent."
            signals.append({"label": "Weekly volume", "value": f"{last7_km:.0f} km", "level": lv, "text": txt})

        if bb is not None or sleep_h is not None:
            rec_low = (bb is not None and bb < 50) or (sleep_h is not None and sleep_h < 6)
            if rec_low:
                lv, txt = "watch", "Recovery looks low today (sleep / body battery) — favour easy running."
            else:
                lv, txt = "good", "Recovery indicators look healthy today."
            val = (f"BB {round(bb)}" if bb is not None else "") + (
                f" · {sleep_h:.1f}h" if sleep_h else ""
            )
            signals.append({"label": "Recovery", "value": val.strip(" ·"), "level": lv, "text": txt})

        # ---------- Overall verdict ----------
        if acwr is not None and acwr > 1.5:
            level = "watch"
            status = "High load — injury risk"
            summary = "Your training load has spiked well above your baseline. Ease back on volume and intensity this week and prioritise recovery to avoid injury."
        elif easy_pct is not None and easy_pct < 50 and acwr is not None and acwr > 1.1:
            level = "watch"
            status = "Too intense — burnout risk"
            summary = "You're doing a lot of hard running while load is climbing. Replace some sessions with easy Z1–2 runs to keep progressing safely."
        elif acwr is not None and 0.8 <= acwr <= 1.3 and (easy_pct is None or easy_pct >= 60):
            level = "good"
            status = "Training well — building fitness"
            summary = "Your load is progressing sustainably with a good easy/hard mix. Keep this rhythm to improve without overreaching."
        elif acwr is not None and acwr < 0.7:
            level = "ok"
            status = "Light training — room to build"
            summary = "You're training below your baseline. If you're not tapering, add volume gradually (~10% per week) to build fitness."
        elif easy_pct is not None and easy_pct < 55:
            level = "watch"
            status = "Too much intensity"
            summary = "Most of your running is tempo/hard. Add more easy Z1–2 miles to build endurance and cut injury risk."
        else:
            level = "ok"
            status = "Solid — minor tweaks"
            summary = "Training is reasonable. Small adjustments to your easy/hard balance and consistency will help you improve."

        recommendations = [s["text"] for s in signals if s["level"] != "good"]
        if not recommendations:
            recommendations = ["Keep doing what you're doing — everything looks balanced."]

        return {
            "status": status,
            "level": level,
            "summary": summary,
            "metrics": {
                "acwr": acwr,
                "easyPct": easy_pct,
                "weeklyKm": round(last7_km, 1),
            },
            "signals": signals,
            "recommendations": recommendations,
        }

    def readiness(self) -> dict[str, Any]:
        """'Train or recover today?' — combines Garmin Training Readiness with
        resting HR, Body Battery, sleep and (if available) HRV into one call."""
        client = self._require_client()
        today = dt.date.today()

        tr = _safe(client.get_training_readiness, today.isoformat())
        tr0: dict[str, Any] = {}
        if isinstance(tr, list) and tr:
            tr0 = tr[0]
        elif isinstance(tr, dict):
            tr0 = tr
        score = tr0.get("score")
        recovery_min = tr0.get("recoveryTime")

        stats = self.daily_stats(today.isoformat())
        rhr = stats.get("restingHeartRate")
        bb = stats.get("bodyBatteryHighestValue")
        sleep_h = round((stats.get("sleepingSeconds") or 0) / 3600, 1) or None

        hrv = _safe(client.get_hrv_data, today.isoformat())
        hrv_status = None
        if isinstance(hrv, dict):
            hrv_status = (hrv.get("hrvSummary") or {}).get("status")

        if score is None:
            level, headline, advice = (
                "ok",
                "Readiness unavailable",
                "No training-readiness data for today yet — check back after your watch syncs.",
            )
        elif score >= 75:
            level, headline, advice = (
                "good",
                "Ready to train hard",
                "Great day for a quality session or long run. Your body is recovered.",
            )
        elif score >= 50:
            level, headline, advice = (
                "ok",
                "Moderately ready",
                "Easy to steady running is ideal today — keep the intensity in check.",
            )
        else:
            level, headline, advice = (
                "watch",
                "Prioritise recovery",
                "You're still recovering. Keep it to an easy jog or take a rest day.",
            )

        factors: list[dict[str, Any]] = []
        if score is not None:
            factors.append({"label": "Readiness score", "value": f"{score}/100", "level": level})
        if recovery_min:
            factors.append({
                "label": "Recovery time",
                "value": _fmt_hours(recovery_min),
                "level": "watch" if recovery_min > 1440 else "ok",
            })
        if bb is not None:
            factors.append({
                "label": "Body Battery",
                "value": f"{round(bb)}",
                "level": "good" if bb >= 75 else "ok" if bb >= 50 else "watch",
            })
        if sleep_h:
            factors.append({
                "label": "Sleep",
                "value": f"{sleep_h} h",
                "level": "good" if sleep_h >= 7 else "ok" if sleep_h >= 6 else "watch",
            })
        if rhr:
            factors.append({"label": "Resting HR", "value": f"{round(rhr)} bpm", "level": "ok"})
        if hrv_status:
            factors.append({"label": "HRV status", "value": str(hrv_status).title(), "level": "ok"})

        return {
            "level": level,
            "headline": headline,
            "advice": advice,
            "score": score,
            "factors": factors,
        }

    def weekly_report(self) -> dict[str, Any]:
        """Auto-generated summary of this week vs last week with a coaching note."""
        client = self._require_client()
        today = dt.date.today()
        start = today - dt.timedelta(days=21)
        acts = (
            _safe(client.get_activities_by_date, start.isoformat(), today.isoformat(), "running")
            or []
        )

        def a_date(a):
            try:
                return dt.date.fromisoformat((a.get("startTimeLocal") or "")[:10])
            except ValueError:
                return None

        cur_week = today - dt.timedelta(days=today.weekday())
        last_week = cur_week - dt.timedelta(days=7)

        def summarise(wk_start: dt.date) -> dict[str, Any]:
            wk_end = wk_start + dt.timedelta(days=7)
            ws = [a for a in acts if (d := a_date(a)) and wk_start <= d < wk_end]
            km = sum((a.get("distance") or 0) for a in ws) / 1000
            longest = max((a.get("distance") or 0) for a in ws) / 1000 if ws else 0
            load = sum((a.get("activityTrainingLoad") or 0) for a in ws)
            quality = sum(
                1
                for a in ws
                if a.get("hasIntensityIntervals")
                or (a.get("trainingEffectLabel") or "").upper()
                in ("TEMPO", "THRESHOLD", "VO2MAX", "ANAEROBIC", "LACTATE_THRESHOLD")
            )
            z = [0.0] * 5
            for a in ws:
                for i in range(5):
                    z[i] += a.get(f"hrTimeInZone_{i + 1}") or 0
            zt = sum(z)
            easy_pct = round((z[0] + z[1]) / zt * 100) if zt else None
            return {
                "km": round(km, 1),
                "runs": len(ws),
                "longestKm": round(longest, 1),
                "load": round(load),
                "quality": quality,
                "easyPct": easy_pct,
            }

        this_w = summarise(cur_week)
        last_w = summarise(last_week)

        # Coaching note
        notes = []
        if last_w["km"] > 0:
            change = round((this_w["km"] - last_w["km"]) / last_w["km"] * 100)
            if change > 30:
                notes.append(f"Mileage is up {change}% on last week — a big jump; make sure most of it is easy.")
            elif change < -30:
                notes.append(f"Mileage is down {abs(change)}% — a cutback/recovery week, which is healthy periodically.")
            else:
                notes.append(f"Mileage is {'up' if change >= 0 else 'down'} {abs(change)}% vs last week — a steady, sustainable change.")
        if this_w["easyPct"] is not None and this_w["easyPct"] < 60:
            notes.append(f"Only {this_w['easyPct']}% of your time was easy — add more Z1–2 running to balance the {this_w['quality']} hard session(s).")
        if this_w["quality"] == 0 and this_w["runs"] >= 3:
            notes.append("All easy this week — a single tempo or interval session would add a quality stimulus.")
        if this_w["longestKm"] and this_w["km"] and this_w["longestKm"] / this_w["km"] > 0.45:
            notes.append("Your long run was a large share of weekly volume — build weekly base so it's ~30–35%.")
        if not notes:
            notes.append("Nicely balanced week — keep the rhythm going.")

        return {
            "weekLabel": cur_week.strftime("%b %d"),
            "thisWeek": this_w,
            "lastWeek": last_w,
            "note": " ".join(notes),
        }

    def performance_analysis(self, days: int = 90) -> dict[str, Any]:
        """Deep performance analysis across recent runs.

        Covers heart-rate zone distribution (80/20), training-load ACWR,
        running-form biomechanics, cadence-vs-pace, grade-adjusted pace and
        aerobic decoupling on the longest recent run.
        """
        client = self._require_client()
        today = dt.date.today()
        start = today - dt.timedelta(days=days)
        acts = (
            _safe(
                client.get_activities_by_date,
                start.isoformat(),
                today.isoformat(),
                "running",
            )
            or []
        )

        def a_date(a: dict[str, Any]) -> dt.date | None:
            try:
                return dt.date.fromisoformat((a.get("startTimeLocal") or "")[:10])
            except ValueError:
                return None

        # ---------------- Heart-rate zone distribution (80/20) ----------------
        # Polarized model:
        #   Low  (Z1–Z2) = below LT1, conversational  -> the "80%"
        #   Moderate (Z3) = LT1–LT2, "comfortably hard" -> part of the "20%"
        #   High (Z4–Z5) = at/above LT2, anaerobic       -> part of the "20%"
        zsec = [0.0] * 5
        for a in acts:
            for i in range(5):
                zsec[i] += a.get(f"hrTimeInZone_{i + 1}") or 0
        ztotal = sum(zsec)
        zpct = [round(z / ztotal * 100, 1) if ztotal else 0 for z in zsec]
        low = round(zpct[0] + zpct[1], 1)   # Z1–Z2, the 80% target
        moderate = zpct[2]                  # Z3
        high = round(zpct[3] + zpct[4], 1)  # Z4–Z5
        if ztotal == 0:
            hr_v = {"level": None, "text": "No heart-rate zone data available."}
        elif low >= 75:
            hr_v = {"level": "good", "text": f"{low:.0f}% is low-intensity (Z1–2, below LT1) — an excellent polarized base, near the 80% target."}
        elif low >= 55:
            hr_v = {"level": "ok", "text": f"{low:.0f}% low-intensity (Z1–2). Aim for ~80% easy below LT1 to build your aerobic engine and cut injury risk."}
        else:
            hr_v = {"level": "watch", "text": f"Only {low:.0f}% is truly easy (Z1–2). You spend a lot in Z3+ — add more slow, conversational running to reach the 80% target."}

        # ---------------- Training load — ACWR ----------------
        load7 = sum(
            (a.get("activityTrainingLoad") or 0)
            for a in acts
            if (d := a_date(a)) and d >= today - dt.timedelta(days=7)
        )
        load28 = sum(
            (a.get("activityTrainingLoad") or 0)
            for a in acts
            if (d := a_date(a)) and d >= today - dt.timedelta(days=28)
        )
        chronic = load28 / 4
        acwr = round(load7 / chronic, 2) if chronic > 0 else None
        if acwr is None:
            load_v = {"level": None, "text": "Not enough training-load history yet."}
        elif acwr < 0.8:
            load_v = {"level": "ok", "text": "Load is below your baseline — good for recovery/taper, or ramp up gradually if building."}
        elif acwr <= 1.3:
            load_v = {"level": "good", "text": "You're in the safe 'sweet spot' (0.8–1.3) — a sustainable rate of progression."}
        elif acwr <= 1.5:
            load_v = {"level": "ok", "text": "Slightly high — watch for fatigue and don't add much more this week."}
        else:
            load_v = {"level": "watch", "text": "Ramping up too fast — injury risk is elevated. Ease back this week."}

        # ---------------- Running form (biomechanics) ----------------
        # Exclude walking-pace activities (slower than 10:00/km) — they distort
        # cadence and the other form metrics.
        def is_running_pace(a: dict[str, Any]) -> bool:
            sp = a.get("averageSpeed")
            return bool(sp and sp > 0 and (1000 / sp) / 60 <= 10)

        run_acts = [a for a in acts if is_running_pace(a)]

        def avg(field: str) -> float | None:
            vals = [a.get(field) for a in run_acts if a.get(field)]
            return sum(vals) / len(vals) if vals else None

        cad = avg("averageRunningCadenceInStepsPerMinute")
        vo = avg("avgVerticalOscillation")
        vr = avg("avgVerticalRatio")
        gct = avg("avgGroundContactTime")
        sl = avg("avgStrideLength")

        def rate(v, good, ok, lower_is_better=True):
            if v is None:
                return None
            if lower_is_better:
                if v <= good:
                    return "good"
                if v <= ok:
                    return "ok"
                return "watch"
            else:
                if v >= good:
                    return "good"
                if v >= ok:
                    return "ok"
                return "watch"

        form = {
            "cadence": {
                "value": round(cad, 0) if cad else None,
                "unit": "spm",
                "level": rate(cad, 170, 165, lower_is_better=False),
                "text": "Quicker, lighter steps (170–180 spm) reduce overstriding and impact.",
            },
            "verticalOscillation": {
                "value": round(vo, 1) if vo else None,
                "unit": "cm",
                "level": rate(vo, 8, 10),
                "text": "How much you bounce vertically. Less bounce = less wasted energy.",
            },
            "verticalRatio": {
                "value": round(vr, 1) if vr else None,
                "unit": "%",
                "level": rate(vr, 7, 9),
                "text": "Bounce relative to stride length — a key efficiency measure (lower is better).",
            },
            "groundContactTime": {
                "value": round(gct, 0) if gct else None,
                "unit": "ms",
                "level": rate(gct, 250, 300),
                "text": "Time each foot is on the ground. Faster runners spend less time grounded.",
            },
            "strideLength": {
                "value": round(sl, 0) if sl else None,
                "unit": "cm",
                "level": None,
                "text": "Average distance per step. Balances with cadence to set your pace.",
            },
        }

        # ---------------- Cadence vs pace ----------------
        # Pace: use the run-detection "RWD_RUN" split (excludes walk/stand).
        # Cadence: the split summary has no cadence, so for the most recent runs
        # (capped to limit API calls) fetch typed splits and take the distance-
        # weighted RWD_RUN cadence; older runs fall back to the overall cadence.
        def running_speed(a: dict[str, Any]) -> float | None:
            for s in a.get("splitSummaries") or []:
                if s.get("splitType") == "RWD_RUN" and s.get("averageSpeed"):
                    return s.get("averageSpeed")
            return a.get("averageSpeed")

        def running_cadence(activity_id) -> float | None:
            return self.running_only_cadence(activity_id)

        CADENCE_FETCH_CAP = 40
        acts_recent = sorted(
            acts, key=lambda a: a.get("startTimeLocal") or "", reverse=True
        )
        cadence_vs_pace = []
        fetched = 0
        for a in acts_recent:
            sp = running_speed(a)
            if not sp or sp <= 0:
                continue
            pace = (1000 / sp) / 60
            if pace > 10:  # slower than 10:00/km — treat as walking, skip
                continue
            cad = a.get("averageRunningCadenceInStepsPerMinute")
            # Only the whole-activity cadence is dragged down by walk/stop time.
            # A value well below a normal running cadence signals contamination —
            # for those (regardless of age), fetch the run-only cadence.
            if (cad is None or cad < 150) and fetched < CADENCE_FETCH_CAP:
                rc = running_cadence(a.get("activityId"))
                fetched += 1
                if rc:
                    cad = rc
            # A running cadence below ~120 spm at a running pace is bad data
            # (walk/stop contamination we couldn't salvage) — leave it out.
            if not cad or cad < 120:
                continue
            cadence_vs_pace.append(
                {
                    "pace": round(pace, 2),
                    "cadence": round(cad, 1),
                    "activityId": a.get("activityId"),
                    "name": a.get("activityName"),
                    "date": (a.get("startTimeLocal") or "")[:10],
                }
            )

        # ---------------- Grade-adjusted pace ----------------
        diffs = []
        for a in acts:
            sp = a.get("averageSpeed")
            gsp = a.get("avgGradeAdjustedSpeed")
            if sp and gsp and sp > 0 and gsp > 0:
                d = (1000 / sp) - (1000 / gsp)  # sec/km, actual minus grade-adjusted
                if abs(d) < 120:  # ignore corrupt/outlier records
                    diffs.append(d)
        import statistics

        gap_diff = round(statistics.median(diffs), 0) if diffs else None
        if gap_diff is None:
            gap = {"diffSec": None, "text": "No grade data available."}
        elif gap_diff >= 4:
            gap = {"diffSec": gap_diff, "text": f"Your runs are hilly — on flat ground your equivalent pace is about {abs(gap_diff):.0f} s/km faster. Don't judge hilly runs on raw pace."}
        elif gap_diff <= -4:
            gap = {"diffSec": gap_diff, "text": "Your runs are net downhill — flat-ground equivalent pace would be a little slower."}
        else:
            gap = {"diffSec": gap_diff, "text": "Your runs are mostly flat — pace and effort line up well."}

        # ---------------- Aerobic decoupling (longest run) ----------------
        decoupling = None
        longest = max(acts, key=lambda a: a.get("distance") or 0, default=None)
        if longest and (longest.get("duration") or 0) >= 1800:
            laps = (self.activity_laps(str(longest["activityId"])) or {}).get("laps", [])
            total_t = sum((l.get("durationSec") or 0) for l in laps)
            if total_t > 0 and len(laps) >= 2:
                half = total_t / 2
                cum = 0.0
                first, second = [], []
                for l in laps:
                    (first if cum < half else second).append(l)
                    cum += l.get("durationSec") or 0

                def half_eff(ls):
                    t = sum((l.get("durationSec") or 0) for l in ls)
                    if t == 0:
                        return None
                    sp = sum((l.get("averageSpeed") or 0) * (l.get("durationSec") or 0) for l in ls) / t
                    hr = sum((l.get("averageHR") or 0) * (l.get("durationSec") or 0) for l in ls) / t
                    return (sp / hr) if hr else None

                e1, e2 = half_eff(first), half_eff(second)
                if e1 and e2:
                    dec = round((e1 - e2) / e1 * 100, 1)
                    if dec < 5:
                        dv = {"level": "good", "text": "Low decoupling — excellent aerobic durability; your pace held without HR drifting up."}
                    elif dec <= 8:
                        dv = {"level": "ok", "text": "Moderate decoupling — decent endurance; more long easy runs will improve it."}
                    else:
                        dv = {"level": "watch", "text": "High decoupling — your HR drifted up in the second half. Build your aerobic base with easy long runs."}
                    decoupling = {
                        "value": dec,
                        "activityName": longest.get("activityName"),
                        "date": (longest.get("startTimeLocal") or "")[:10],
                        "distanceKm": round((longest.get("distance") or 0) / 1000, 2),
                        "activityId": longest.get("activityId"),
                        "verdict": dv,
                    }

        # ---------------- Injury-risk flag ----------------
        inj_factors: list[dict[str, Any]] = []
        risk = 0

        if acwr is not None:
            if acwr > 1.5:
                inj_factors.append({"label": "Load ramp (ACWR)", "value": f"{acwr}", "level": "watch", "text": "Training load is spiking well above your baseline."})
                risk += 2
            elif acwr > 1.3:
                inj_factors.append({"label": "Load ramp (ACWR)", "value": f"{acwr}", "level": "ok", "text": "Load is ramping up — keep an eye on fatigue."})
                risk += 1
            else:
                inj_factors.append({"label": "Load ramp (ACWR)", "value": f"{acwr}", "level": "good", "text": "Load progression is in the safe range."})

        last7 = sum((a.get("distance") or 0) for a in acts if (d := a_date(a)) and d >= today - dt.timedelta(days=7)) / 1000
        prior = sum(
            (a.get("distance") or 0)
            for a in acts
            if (d := a_date(a)) and today - dt.timedelta(days=28) <= d < today - dt.timedelta(days=7)
        ) / 1000
        prior_avg = prior / 3 if prior else 0
        if prior_avg > 0:
            vr = last7 / prior_avg
            if vr > 1.4:
                inj_factors.append({"label": "Weekly volume", "value": f"+{round((vr - 1) * 100)}%", "level": "watch", "text": "Weekly mileage jumped sharply — the classic injury trigger. Ramp ~10%/week."})
                risk += 2
            elif vr > 1.25:
                inj_factors.append({"label": "Weekly volume", "value": f"+{round((vr - 1) * 100)}%", "level": "ok", "text": "Mileage rising a bit fast — hold here a week before adding more."})
                risk += 1
            else:
                inj_factors.append({"label": "Weekly volume", "value": f"{'+' if vr >= 1 else ''}{round((vr - 1) * 100)}%", "level": "good", "text": "Weekly volume change is gradual."})

        longest7 = max((a.get("distance") or 0) for a in acts if (d := a_date(a)) and d >= today - dt.timedelta(days=7)) / 1000 if last7 else 0
        if last7 > 0 and longest7:
            share = longest7 / last7
            if share > 0.5:
                inj_factors.append({"label": "Long-run share", "value": f"{round(share * 100)}%", "level": "watch", "text": "Your long run is a big chunk of weekly volume — build the rest of the week up."})
                risk += 1
            else:
                inj_factors.append({"label": "Long-run share", "value": f"{round(share * 100)}%", "level": "good", "text": "Long run is a healthy fraction of your weekly volume."})

        inj_level = "watch" if risk >= 3 else "ok" if risk >= 1 else "good"
        inj_headline = {
            "watch": "Elevated injury risk — ease back",
            "ok": "Moderate — manageable, stay attentive",
            "good": "Low injury risk — training is sustainable",
        }[inj_level]
        injury_risk = {"level": inj_level, "headline": inj_headline, "factors": inj_factors}

        return {
            "period": days,
            "runCount": len(acts),
            "hrZones": {
                "seconds": [round(z) for z in zsec],
                "percent": zpct,
                "lowPct": low,
                "moderatePct": moderate,
                "highPct": high,
                "verdict": hr_v,
            },
            "load": {
                "acute": round(load7),
                "chronic": round(chronic),
                "acwr": acwr,
                "verdict": load_v,
            },
            "form": form,
            "cadenceVsPace": cadence_vs_pace,
            "gap": gap,
            "decoupling": decoupling,
            "injuryRisk": injury_risk,
        }

    def running_insights(self) -> dict[str, Any]:
        """Marathon-training insights: PRs, race predictions and weekly mileage."""
        client = self._require_client()
        today = dt.date.today()
        year_ago = today - dt.timedelta(days=365)

        acts = (
            _safe(
                client.get_activities_by_date,
                year_ago.isoformat(),
                today.isoformat(),
                "running",
            )
            or []
        )

        # ----- Personal records from Garmin's fastest-split fields -----
        split_fields = [
            ("1 km", "fastestSplit_1000"),
            ("1 mile", "fastestSplit_1609"),
            ("5 km", "fastestSplit_5000"),
            ("10 km", "fastestSplit_10000"),
        ]
        records: list[dict[str, Any]] = []
        best_by_field: dict[str, float] = {}
        for label, field in split_fields:
            best = None
            for a in acts:
                v = a.get(field)
                if v and (best is None or v < best["timeSec"]):
                    best = {
                        "label": label,
                        "timeSec": round(v, 1),
                        "date": (a.get("startTimeLocal") or "")[:10],
                        "activityId": a.get("activityId"),
                    }
            if best:
                records.append(best)
                best_by_field[field] = best["timeSec"]

        # ----- Longest run -----
        longest = None
        for a in acts:
            dist = a.get("distance") or 0
            if longest is None or dist > longest["distanceMeters"]:
                longest = {
                    "distanceMeters": dist,
                    "km": round(dist / 1000, 2),
                    "durationSec": a.get("duration"),
                    "date": (a.get("startTimeLocal") or "")[:10],
                    "activityId": a.get("activityId"),
                }

        # ----- Weekly mileage for the last 12 weeks -----
        from collections import defaultdict

        week_km: dict[dt.date, float] = defaultdict(float)
        for a in acts:
            start = a.get("startTimeLocal") or ""
            try:
                a_date = dt.date.fromisoformat(start[:10])
            except ValueError:
                continue
            week_start = a_date - dt.timedelta(days=a_date.weekday())
            week_km[week_start] += a.get("distance") or 0

        current_week = today - dt.timedelta(days=today.weekday())
        weekly = []
        for i in range(11, -1, -1):
            ws = current_week - dt.timedelta(weeks=i)
            weekly.append(
                {"week": ws.strftime("%b %d"), "km": round(week_km.get(ws, 0) / 1000, 1)}
            )

        # ----- Race-time predictions (Riegel formula) -----
        # Prefer the longest reliable best effort as the basis.
        basis = None
        for field, dist, name in [
            ("fastestSplit_10000", 10000, "10K"),
            ("fastestSplit_5000", 5000, "5K"),
            ("fastestSplit_1609", 1609, "1 mile"),
            ("fastestSplit_1000", 1000, "1 km"),
        ]:
            if field in best_by_field:
                basis = (best_by_field[field], dist, name)
                break

        predictions: list[dict[str, Any]] = []
        prediction_basis = None
        if basis:
            t1, d1, name = basis
            prediction_basis = f"Based on your best {name} ({_fmt_time(t1)})"
            for label, d2 in [
                ("5K", 5000),
                ("10K", 10000),
                ("Half Marathon", 21097.5),
                ("Marathon", 42195),
            ]:
                predictions.append(
                    {"label": label, "timeSec": round(t1 * (d2 / d1) ** 1.06)}
                )

        return {
            "records": records,
            "longestRun": longest,
            "weekly": weekly,
            "predictions": predictions,
            "predictionBasis": prediction_basis,
        }

    def vo2max_improving_activities(self, days: int) -> dict[str, Any]:
        """List running activities that raised the VO2 max estimate.

        Garmin attaches a VO2 max estimate to GPS runs. Walking through those
        activities chronologically, any activity whose estimate is higher than
        the previous valued activity is one that improved the user's VO2 max.
        """
        client = self._require_client()
        today = dt.date.today()
        start = today - dt.timedelta(days=days)

        acts = (
            _safe(
                client.get_activities_by_date,
                start.isoformat(),
                today.isoformat(),
                "running",
            )
            or []
        )

        # Keep only runs that carry a VO2 max estimate, oldest first.
        valued = []
        for a in acts:
            v = a.get("vO2MaxValue")
            if v is None:
                continue
            valued.append((a.get("startTimeLocal") or "", v, a))
        valued.sort(key=lambda t: t[0])

        improving: list[dict[str, Any]] = []
        prev = None
        for _, v, a in valued:
            if prev is not None and v > prev:
                improving.append(_improvement_entry(a, prev, v))
            prev = v if prev is None else max(prev, v)

        improving.reverse()  # newest first
        total_gain = round(sum(e["delta"] for e in improving), 1)
        return {
            "count": len(improving),
            "totalGain": total_gain,
            "activities": improving,
        }

    def steps_history(self, days: int = 7) -> list[dict[str, Any]]:
        """Return total steps / distance / calories for the last `days` days."""
        client = self._require_client()
        today = dt.date.today()
        history: list[dict[str, Any]] = []
        for offset in range(days - 1, -1, -1):
            day = (today - dt.timedelta(days=offset)).isoformat()
            stats = _safe(client.get_stats, day) or {}
            history.append(
                {
                    "date": day,
                    "steps": stats.get("totalSteps") or 0,
                    "distance": stats.get("totalDistanceMeters") or 0,
                    "calories": stats.get("totalKilocalories") or 0,
                    "activeCalories": stats.get("activeKilocalories") or 0,
                    "floors": stats.get("floorsAscended") or 0,
                    "restingHeartRate": stats.get("restingHeartRate"),
                }
            )
        return history


def _normalize_activity(a: dict[str, Any]) -> dict[str, Any]:
    """Flatten the noisy Garmin activity payload into what the UI needs."""
    activity_type = (a.get("activityType") or {}).get("typeKey", "unknown")
    distance_m = a.get("distance") or 0
    duration_s = a.get("duration") or 0
    avg_speed = a.get("averageSpeed") or 0  # meters/second

    # Pace in minutes per km (only meaningful for foot sports).
    pace_min_per_km = None
    if avg_speed and avg_speed > 0:
        pace_min_per_km = (1000 / avg_speed) / 60

    return {
        "activityId": a.get("activityId"),
        "name": a.get("activityName"),
        "type": activity_type,
        "startTime": a.get("startTimeLocal"),
        "distanceKm": round(distance_m / 1000, 2),
        "durationSec": duration_s,
        "calories": a.get("calories"),
        "averageHR": a.get("averageHR"),
        "maxHR": a.get("maxHR"),
        "paceMinPerKm": round(pace_min_per_km, 2) if pace_min_per_km else None,
        "averageSpeed": avg_speed,
        "elevationGain": a.get("elevationGain"),
        "vo2Max": a.get("vO2MaxValue"),
        "averageCadence": a.get("averageRunningCadenceInStepsPerMinute"),
        "aerobicTrainingEffect": a.get("aerobicTrainingEffect"),
        "anaerobicTrainingEffect": a.get("anaerobicTrainingEffect"),
        "hasIntervals": bool(a.get("hasIntensityIntervals")),
        "benefit": a.get("trainingEffectLabel"),
    }


_PHASE_LABELS = {
    "WARMUP": "Warm up",
    "COOLDOWN": "Cool down",
    "RECOVERY": "Recovery",
    "REST": "Rest",
    "ACTIVE": "Active",
    "INTERVAL": "Run",
}


def _phase_label(intensity: str | None) -> str | None:
    """Map a Garmin lap intensityType to a human-friendly phase name."""
    if not intensity:
        return None
    return _PHASE_LABELS.get(intensity.upper(), intensity.title())


def _fmt_time(seconds: float) -> str:
    """Format seconds as H:MM:SS or M:SS."""
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _fmt_hours(minutes: float) -> str:
    """Format a duration in minutes as e.g. '32h' or '45m'."""
    minutes = int(round(minutes or 0))
    if minutes >= 60:
        return f"{minutes // 60}h"
    return f"{minutes}m"


def _interval_similarity(sig1: dict[str, Any], sig2: dict[str, Any]) -> float:
    """Score how similar two interval patterns are (lower = more similar)."""
    count_diff = abs(sig1["count"] - sig2["count"])
    d1, d2 = sig1["distances"], sig2["distances"]
    n = min(len(d1), len(d2))
    elem = sum(abs(d1[i] - d2[i]) for i in range(n))
    leftover = sum(d1[n:]) + sum(d2[n:])
    total_diff = abs(sig1["total"] - sig2["total"])
    return count_diff * 5 + elem + leftover + total_diff * 0.3


def _improvement_entry(a: dict[str, Any], prev: float, current: float) -> dict[str, Any]:
    """Build a VO2-max improvement list entry from a raw activity."""
    speed = a.get("averageSpeed") or 0
    return {
        "activityId": a.get("activityId"),
        "name": a.get("activityName"),
        "type": (a.get("activityType") or {}).get("typeKey"),
        "startTime": a.get("startTimeLocal"),
        "distanceKm": round((a.get("distance") or 0) / 1000, 2),
        "durationSec": a.get("duration"),
        "paceMinPerKm": round((1000 / speed) / 60, 2) if speed else None,
        "averageHR": a.get("averageHR"),
        "vo2From": round(prev, 1),
        "vo2To": round(current, 1),
        "delta": round(current - prev, 1),
    }


def _safe(fn, *args):
    """Call a Garmin API method, swallowing per-endpoint failures.

    Garmin frequently returns 404/empty for metrics that have no data for a
    given day; we don't want one missing metric to break the whole dashboard.
    """
    try:
        return fn(*args)
    except (
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
        GarminConnectAuthenticationError,
    ):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.debug("Garmin call %s failed: %s", getattr(fn, "__name__", fn), exc)
        return None
