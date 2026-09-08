// Garmin Training Portal — frontend logic.
// Talks to the FastAPI backend on the same origin.

const API = "";
let allActivities = [];
let stravaActivities = [];
let stravaConnected = false;
let garminConnected = false;
let monthlyKmChart = null;
let weeklyKmChart = null;
let mileageChart = null;
let mileageMode = "weekly";
let reportData = { monthly: [], weekly: [] };
let dashSummary = null;
let weeklyProgress = null;
let yearProjection = null;
let showAllStats = false;
let guidanceData = null;
let readinessData = null;
let racePrediction = null;
let lactateThreshold = null;
let stravaGear = null;
let stravaStreak = null;
let stravaYearlyGoal = null;
let runMonthKm = null;
let hrZoneChart = null;
let cadencePaceChart = null;
let currentSportFilter = "all";
let currentActivityQuery = "days=30";
let currentTagFilter = "all";

// Multi-activity comparison state.
let compareMode = false;
const compareSelection = new Set(); // activityIds of Garmin activities picked
let multiCompareCharts = [];

// Plain-language descriptions for Garmin training statuses.
const TRAINING_STATUS = {
  recovery: { icon: "🌿", desc: "Light recent load — your body is recovering and letting recent gains settle in. Good time for easy runs or rest." },
  productive: { icon: "📈", desc: "Your training load is paying off — your fitness (VO₂ max) is improving. Keep the current balance." },
  maintaining: { icon: "➡️", desc: "You're holding your current fitness. Add a bit more load to start improving again." },
  peaking: { icon: "🔝", desc: "You're at peak fitness and race-ready. Ideal window for an event." },
  strained: { icon: "⚠️", desc: "You're training harder than your body is currently handling. Ease off to avoid overtraining." },
  unproductive: { icon: "📉", desc: "Training hard but fitness isn't rising — often fatigue, stress or nutrition. Consider more recovery." },
  detraining: { icon: "💤", desc: "Reduced training lately and fitness is slipping. Get back to regular sessions." },
  overreaching: { icon: "🥵", desc: "Training load is well above your usual — sustainable only briefly. Plan recovery soon." },
};
let vo2Chart = null;
let vo2CurrentMetric = "running";
let vo2CurrentPeriod = "6m";
let trainingPeriod = "3m";
let trainingChart = null;
let lapsChart = null;
let lapState = null;

// ----------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch (_) {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2800);
}

function fmtDuration(sec) {
  if (!sec) return "–";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPace(p) {
  if (!p) return "–";
  const m = Math.floor(p);
  const s = Math.round((p - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

function fmtClock(sec) {
  if (sec == null) return "–";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function num(v, suffix = "") {
  if (v === null || v === undefined) return "–";
  return `${Math.round(v).toLocaleString()}${suffix}`;
}

// Escape a string for safe use inside an HTML attribute (e.g. title="…").
function escapeAttr(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SPORT_ICONS = {
  running: "🏃",
  trail_running: "🏞️",
  treadmill_running: "🏃",
  cycling: "🚴",
  road_biking: "🚴",
  indoor_cycling: "🚴",
  walking: "🚶",
  hiking: "🥾",
  swimming: "🏊",
  lap_swimming: "🏊",
  strength_training: "🏋️",
  cardio: "💪",
  yoga: "🧘",
};

function sportIcon(type) {
  return SPORT_ICONS[type] || "🏅";
}

// Strava workout_type tags (race / long run / workout) shown as row badges.
const TAG_META = {
  race: { icon: "🏁", label: "Race", cls: "tag-race" },
  long_run: { icon: "🏃", label: "Long run", cls: "tag-long" },
  workout: { icon: "⚡", label: "Workout", cls: "tag-workout" },
};

// Colour class for a Garmin training-effect / primary-benefit label.
function benefitClass(raw) {
  const key = String(raw || "").toLowerCase();
  if (key.includes("recovery")) return "b-recovery";
  if (key.includes("tempo")) return "b-tempo";
  if (key.includes("threshold") || key.includes("lactate")) return "b-threshold";
  if (key.includes("vo2") || key.includes("vo₂")) return "b-vo2";
  if (key.includes("anaerobic")) return "b-anaerobic";
  if (key.includes("sprint")) return "b-sprint";
  if (key.includes("base") || key.includes("aerobic")) return "b-base";
  return "b-default";
}

// ----------------------------------------------------------- auth

function setBtnLoading(btn, loading, loadingText, idleText) {
  if (loading) {
    btn.disabled = true;
    btn.classList.add("loading");
    btn.innerHTML = `<span class="spinner"></span>${loadingText}`;
  } else {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.textContent = idleText;
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  const err = document.getElementById("login-error");
  err.classList.add("hidden");
  setBtnLoading(btn, true, "Signing in…");

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value,
      }),
    });

    if (data.status === "mfa_required") {
      document.getElementById("login-form").classList.add("hidden");
      document.getElementById("mfa-form").classList.remove("hidden");
      setBtnLoading(btn, false, "", "Sign in");
      document.getElementById("mfa-code").focus();
      return;
    }
    await loadDashboard();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    setBtnLoading(btn, false, "", "Sign in");
  }
});

document.getElementById("mfa-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("mfa-btn");
  const err = document.getElementById("login-error");
  err.classList.add("hidden");
  setBtnLoading(btn, true, "Verifying…");
  try {
    await api("/api/mfa", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("mfa-code").value.trim() }),
    });
    await loadDashboard();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    setBtnLoading(btn, false, "", "Verify");
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  show("login-view");
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("mfa-form").classList.add("hidden");
});

// Log in with Strava (OAuth redirect) from the login screen.
document.getElementById("strava-login-btn").addEventListener("click", () => {
  window.location.href = "/api/strava/connect";
});

// Connect Garmin from the dashboard (Strava-first users).
document.getElementById("connect-garmin-btn").addEventListener("click", () => {
  show("login-view");
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("mfa-form").classList.add("hidden");
  document.getElementById("login-error").classList.add("hidden");
});

document.getElementById("refresh-btn").addEventListener("click", () => {
  loadDashboard();
  toast("Refreshing…");
});

// Re-evaluate how many stat tiles fit when the window resizes.
let _statResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_statResizeTimer);
  _statResizeTimer = setTimeout(() => {
    if (dashSummary && document.getElementById("dashboard-view").classList.contains("active")) {
      renderStatCards();
    }
  }, 200);
});

document.getElementById("activity-filter").addEventListener("change", (e) => {
  currentSportFilter = e.target.value;
  renderActivities(currentSportFilter);
});

document.getElementById("activity-tag-filter").addEventListener("change", (e) => {
  currentTagFilter = e.target.value;
  // Races / long runs / workouts are infrequent — when one is picked, widen
  // the date range to the last year so there's actually something to show.
  const rangeSel = document.getElementById("activity-range");
  if (currentTagFilter !== "all" && rangeSel && rangeSel.value !== "days:365") {
    rangeSel.value = "days:365";
    currentActivityQuery = "days=365";
    // Reload Garmin + Strava together; the loader stays until both finish and
    // the list renders once (no partial/stale flash, no wiped loader).
    reloadAllActivities();
  } else {
    renderActivities(currentSportFilter);
  }
});

document.getElementById("activity-range").addEventListener("change", (e) => {
  const [kind, val] = e.target.value.split(":");
  currentActivityQuery = `${kind}=${val}`;
  reloadAllActivities();
});

document.getElementById("strava-btn").addEventListener("click", onStravaButton);

// Running insights modal (loaded on demand).
let insightsLoaded = false;
document.getElementById("open-insights").addEventListener("click", openInsightsModal);
document.getElementById("insights-close").addEventListener("click", closeInsightsModal);
document.getElementById("insights-modal").addEventListener("click", (e) => {
  if (e.target.id === "insights-modal") closeInsightsModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInsightsModal();
});

function openInsightsModal() {
  document.getElementById("insights-modal").classList.remove("hidden");
  if (!insightsLoaded) {
    document.getElementById("pr-cards").innerHTML =
      `<div class="empty">Loading insights…</div>`;
    api("/api/running-insights")
      .then((d) => {
        renderRunningInsights(d);
        insightsLoaded = true;
      })
      .catch((ex) => {
        document.getElementById("pr-cards").innerHTML =
          `<div class="empty">Could not load insights: ${ex.message}</div>`;
      });
  }
}

function closeInsightsModal() {
  document.getElementById("insights-modal").classList.add("hidden");
}

document.getElementById("mileage-mode").addEventListener("change", (e) => {
  mileageMode = e.target.value;
  renderMileageChart();
});

// Stat info modal handlers.
document.getElementById("stat-info-close").addEventListener("click", closeStatInfo);
document.getElementById("stat-info-modal").addEventListener("click", (e) => {
  if (e.target.id === "stat-info-modal") closeStatInfo();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeStatInfo();
});

// Range activities modal handlers.
document.getElementById("range-close").addEventListener("click", closeRangeModal);
document.getElementById("range-modal").addEventListener("click", (e) => {
  if (e.target.id === "range-modal") closeRangeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRangeModal();
});

// Performance analysis screen.
document.getElementById("open-analysis").addEventListener("click", openAnalysis);
document.getElementById("analysis-back").addEventListener("click", () => show("dashboard-view"));
document.getElementById("analysis-period").addEventListener("change", (e) => {
  loadAnalysis(e.target.value);
});

function openAnalysis() {
  show("analysis-view");
  loadAnalysis(document.getElementById("analysis-period").value);
}

function loadAnalysis(days) {
  const c = document.getElementById("analysis-content");
  c.innerHTML = `<div class="empty">Analyzing your runs…</div>`;
  Promise.all([
    api(`/api/performance-analysis?days=${days}`),
    api("/api/weekly-report").catch(() => null),
  ])
    .then(([analysis, weekly]) => renderAnalysis(analysis, weekly))
    .catch((ex) => {
      if (ex.status === 401) show("login-view");
      else c.innerHTML = `<div class="empty">Could not analyze: ${ex.message}</div>`;
    });
}

// Loading indicator (spinner) shown inside the activity list area.
function activitiesLoadingHtml() {
  return `<div class="list-loading"><div class="loader-ring"></div><div>Loading activities…</div></div>`;
}

async function reloadActivities() {
  const list = document.getElementById("activities-list");
  list.innerHTML = activitiesLoadingHtml();
  try {
    const acts = await api(`/api/activities?${currentActivityQuery}`);
    allActivities = acts.activities || [];
    renderActivities(currentSportFilter);
  } catch (ex) {
    if (ex.status === 401) show("login-view");
    else list.innerHTML = `<div class="empty">Could not load activities: ${ex.message}</div>`;
  }
}

// Reload Garmin AND Strava activities for the current query, keeping the loader
// visible until BOTH finish so the list isn't rendered with partial/stale data.
async function reloadAllActivities() {
  const list = document.getElementById("activities-list");
  list.innerHTML = activitiesLoadingHtml();

  const jobs = [
    api(`/api/activities?${currentActivityQuery}`)
      .then((r) => {
        allActivities = r.activities || [];
      })
      .catch((ex) => {
        if (ex.status === 401) show("login-view");
        allActivities = [];
      }),
  ];
  if (stravaConnected) {
    jobs.push(
      api(`/api/strava/activities?${currentActivityQuery}`)
        .then((r) => {
          stravaActivities = r.activities || [];
        })
        .catch(() => {
          stravaActivities = [];
        })
    );
  }

  await Promise.all(jobs);
  renderActivities(currentSportFilter);
}

// ----------------------------------------------------------- dashboard

function showDashboardLoading() {
  const skel = (cls) => `<div class="${cls} skeleton"></div>`;
  document.getElementById("stat-cards").innerHTML = skel("stat").repeat(6);
  document.getElementById("vo2-panel").innerHTML =
    skel("vo2-item") + skel("vo2-item") + `<div class="vo2-status skeleton"></div>`;
  document.getElementById("report-cards").innerHTML =
    skel("report-card") + skel("report-card");
  const chartWrap = document.querySelector(".run-report .run-chart-wrap");
  if (chartWrap) chartWrap.classList.add("skeleton");
  document.getElementById("activities-list").innerHTML = activitiesLoadingHtml();
  document.getElementById("activities-count").textContent = "";
}

async function loadDashboard() {
  show("dashboard-view");
  insightsLoaded = false;
  showDashboardLoading();
  try {
    const session = await api("/api/session").catch(() => ({}));
    garminConnected = !!session.garmin;
    updateConnectButtons();

    const [profile, dash, acts] = await Promise.all([
      api("/api/profile"),
      api("/api/dashboard"),
      api(`/api/activities?${currentActivityQuery}`),
    ]);

    document.getElementById("user-name").textContent = profile.fullName || profile.email || "";
    setAvatar(profile.avatar);
    renderStatCards(dash.summary);
    renderVo2(dash.vo2max, dash.training);
    allActivities = acts.activities || [];
    renderActivities(currentSportFilter);

    // Strava (extra activity source) loads independently.
    loadStravaStatus();

    // Running report loads independently (it scans the year's activities).
    api("/api/running-report")
      .then(renderRunningReport)
      .catch(() => {});
    api("/api/training-guidance")
      .then(renderGuidance)
      .catch(() => {});
    api("/api/race-prediction")
      .then((rp) => {
        racePrediction = rp;
        renderStatCards();
      })
      .catch(() => {});
    api("/api/lactate-threshold")
      .then((lt) => {
        lactateThreshold = lt;
        renderStatCards();
      })
      .catch(() => {});
    api("/api/readiness")
      .then((r) => {
        readinessData = r;
        renderStatCards();
      })
      .catch(() => {});
  } catch (ex) {
    if (ex.status === 401) {
      show("login-view");
    } else {
      toast(`Error: ${ex.message}`);
    }
  }
}

function renderGuidance(g) {
  guidanceData = g;
  renderStatCards(); // refresh the compact "Training" tile
}

function readinessBodyHtml(r) {
  if (!r) return `<div class="empty">Readiness still loading…</div>`;
  const icon = r.level === "good" ? "🟢" : r.level === "watch" ? "😴" : "🟡";
  const badge = `<span class="assess ${r.level}">${
    r.level === "good" ? "Go" : r.level === "watch" ? "Recover" : "Easy"
  }</span>`;
  const factors = (r.factors || [])
    .map(
      (f) => `
      <div class="coach-signal ${f.level}">
        <div class="cs-lab">${f.label}</div>
        <div class="cs-val">${f.value}</div>
      </div>`
    )
    .join("");
  return `
    <div class="si-head">
      <span class="si-icon">${icon}</span>
      <div>
        <div class="si-title">${r.headline} ${badge}</div>
        <div class="coach-summary">${r.advice}</div>
      </div>
    </div>
    <div class="coach-signals">${factors}</div>
    <div class="si-tip">💡 "Train or recover?" blends Garmin's Training Readiness with your sleep, Body Battery, resting HR and HRV.</div>
  `;
}

function coachBodyHtml(g) {
  if (!g) return `<div class="empty">Training analysis still loading…</div>`;
  const icon = g.level === "good" ? "💪" : g.level === "watch" ? "⚠️" : "🧭";
  const badge = `<span class="assess ${g.level}">${
    g.level === "good" ? "On track" : g.level === "watch" ? "Adjust" : "Heads up"
  }</span>`;
  const signals = (g.signals || [])
    .map(
      (s) => `
      <div class="coach-signal ${s.level}">
        <div class="cs-lab">${s.label}</div>
        <div class="cs-val">${s.value}</div>
        <div class="cs-text">${s.text}</div>
      </div>`
    )
    .join("");
  const recs = (g.recommendations || []).map((r) => `<li>${r}</li>`).join("");
  return `
    <div class="si-head">
      <span class="si-icon">${icon}</span>
      <div>
        <div class="si-title">${g.status} ${badge}</div>
        <div class="coach-summary">${g.summary}</div>
      </div>
    </div>
    <div class="coach-signals">${signals}</div>
    ${recs ? `<div class="coach-recs-head">What to do</div><ul class="coach-recs">${recs}</ul>` : ""}
  `;
}

function openReadinessModal() {
  document.getElementById("stat-info-body").innerHTML = readinessBodyHtml(readinessData);
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openCoachModal() {
  document.getElementById("stat-info-body").innerHTML = coachBodyHtml(guidanceData);
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openTrainReadiModal() {
  const body = document.getElementById("stat-info-body");
  body.innerHTML = `
    <div class="tr-section">
      <div class="tr-heading">🧭 Training</div>
      ${coachBodyHtml(guidanceData)}
    </div>
    <div class="tr-divider"></div>
    <div class="tr-section">
      <div class="tr-heading">🔋 Readiness</div>
      ${readinessBodyHtml(readinessData)}
    </div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

// -------- Combined Training modal (status · readiness · threshold + trend) ----

function trainingThresholdHtml() {
  const lt = lactateThreshold;
  if (!lt || (!lt.hr && !lt.paceMinPerKm)) {
    return `<div class="empty">No lactate threshold data from Garmin yet. It's auto-detected during harder guided runs.</div>`;
  }
  return `
    <div class="coach-signals">
      <div class="coach-signal">
        <div class="cs-lab">Threshold heart rate</div>
        <div class="cs-val">${lt.hr ? `${lt.hr} bpm` : "—"}</div>
      </div>
      <div class="coach-signal">
        <div class="cs-lab">Threshold pace</div>
        <div class="cs-val">${lt.paceMinPerKm ? fmtPace(lt.paceMinPerKm) : "—"}</div>
      </div>
    </div>`;
}

function renderTrainingSummary() {
  const g = guidanceData;
  const r = readinessData;
  const lt = lactateThreshold;
  const thr = lt && lt.paceMinPerKm ? fmtPace(lt.paceMinPerKm) : lt && lt.hr ? `${lt.hr} bpm` : "—";
  const cell = (icon, val, lab, level) =>
    `<div class="ts-card${level ? ` lv-${level}` : ""}">
       <div class="ts-icon">${icon}</div>
       <div class="ts-val">${val}</div>
       <div class="ts-lab">${lab}</div>
     </div>`;
  document.getElementById("training-summary").innerHTML = `
    ${cell("🧭", g ? g.status.split(" — ")[0] : "—", "Training status", g && g.level)}
    ${cell("🔋", r && r.score != null ? `${r.score}/100` : "—", r ? r.headline : "Readiness", r && r.level)}
    ${cell("🩸", thr, "Lactate threshold", null)}
  `;
}

function openTrainingModal() {
  document.getElementById("training-modal").classList.remove("hidden");
  renderTrainingSummary();
  document.getElementById("training-details").innerHTML = `
    <div class="tr-section">
      <div class="tr-heading">🧭 Training status</div>
      ${coachBodyHtml(guidanceData)}
    </div>
    <div class="tr-divider"></div>
    <div class="tr-section">
      <div class="tr-heading">🔋 Readiness</div>
      ${readinessBodyHtml(readinessData)}
    </div>
    <div class="tr-divider"></div>
    <div class="tr-section">
      <div class="tr-heading">🩸 Lactate threshold</div>
      ${trainingThresholdHtml()}
    </div>
  `;
  loadTrainingHistory(trainingPeriod);
}

function closeTrainingModal() {
  document.getElementById("training-modal").classList.add("hidden");
  if (trainingChart) {
    trainingChart.destroy();
    trainingChart = null;
  }
}

async function loadTrainingHistory(period) {
  trainingPeriod = period;
  document.querySelectorAll("#training-periods button").forEach((b) => {
    b.classList.toggle("active", b.dataset.period === period);
  });
  const canvas = document.getElementById("training-chart");
  const empty = document.getElementById("training-empty");
  if (trainingChart) {
    trainingChart.destroy();
    trainingChart = null;
  }
  canvas.style.display = "none";
  empty.classList.remove("hidden");
  empty.innerHTML = `<div class="list-loading"><div class="loader-ring"></div><div>Loading readiness trend…</div></div>`;
  try {
    const data = await api(`/api/training-readiness/history?period=${period}`);
    renderTrainingChart(data.points || []);
  } catch (ex) {
    empty.textContent = `Could not load trend: ${ex.message}`;
    empty.classList.remove("hidden");
  }
}

function renderTrainingChart(points) {
  const canvas = document.getElementById("training-chart");
  const empty = document.getElementById("training-empty");
  const series = points.filter((p) => p.score != null);

  if (!series.length) {
    empty.textContent = "No readiness history for this period.";
    empty.classList.remove("hidden");
    canvas.style.display = "none";
    if (trainingChart) {
      trainingChart.destroy();
      trainingChart = null;
    }
    return;
  }
  empty.classList.add("hidden");
  canvas.style.display = "block";

  const labels = series.map((p) =>
    new Date(p.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  );
  const values = series.map((p) => p.score);

  if (trainingChart) trainingChart.destroy();
  trainingChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Readiness",
          data: values,
          borderColor: "#2dd4bf",
          backgroundColor: "rgba(45, 212, 191, 0.15)",
          fill: true,
          tension: 0.3,
          pointRadius: series.length > 40 ? 0 : 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => `Readiness: ${Math.round(ctx.parsed.y)}/100` },
        },
      },
      scales: {
        x: { ticks: { color: "#9fb0cc", maxTicksLimit: 8, autoSkip: true }, grid: { display: false } },
        y: {
          ticks: { color: "#9fb0cc" },
          grid: { color: "#243450" },
          suggestedMin: 0,
          suggestedMax: 100,
        },
      },
    },
  });
}

function openRacePredictionPopup() {
  const rp = racePrediction;
  const body = document.getElementById("stat-info-body");
  if (!rp || !rp.rows || !rp.rows.length || (!rp.hasGarmin && !rp.hasStrava)) {
    body.innerHTML = `<div class="empty">No race predictions available yet.</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const rows = rp.rows
    .map(
      (r) => `
      <div class="rp-row">
        <div class="rp-dist">${r.label}</div>
        <div class="rp-cell">${r.garminSec != null ? fmtClock(r.garminSec) : "—"}</div>
        <div class="rp-cell">${r.stravaSec != null ? fmtClock(r.stravaSec) : "—"}</div>
      </div>`
    )
    .join("");
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">🏁</span>
      <div>
        <div class="si-title">Race predictions</div>
        <div class="coach-summary">Garmin's own predictions and Strava's projected times, side by side.</div>
      </div>
    </div>
    <div class="rp-table">
      <div class="rp-row rp-head">
        <div class="rp-dist">Distance</div>
        <div class="rp-cell">⌚ Garmin</div>
        <div class="rp-cell">🟠 Strava</div>
      </div>
      ${rows}
    </div>
    <div class="si-tip">💡 Garmin values are Garmin Connect's race predictor. Strava values are projected from your best recent efforts. “—” means not enough data.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

// --------------------------------------------------------- strava tiles

function fmtKm(v) {
  return (v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function buildGoals() {
  const goals = [];
  if (weeklyProgress) {
    const target = weeklyProgress.targetKm || 0;
    const cur = weeklyProgress.currentKm || 0;
    goals.push({
      name: "Weekly distance",
      short: "W",
      current: cur,
      target,
      unit: "km",
      pct: target > 0 ? Math.round((cur / target) * 100) : 0,
      expectedPct: target > 0 ? Math.round(((weeklyProgress.expectedSoFarKm || 0) / target) * 100) : 0,
    });
  }
  if (runMonthKm != null) {
    const wt = weeklyProgress ? weeklyProgress.targetKm || 0 : 0;
    const target = Math.max(Math.round((wt * 4.345) / 10) * 10, 10);
    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    goals.push({
      name: "Monthly distance",
      short: "M",
      current: runMonthKm,
      target,
      unit: "km",
      pct: target > 0 ? Math.round((runMonthKm / target) * 100) : 0,
      expectedPct: Math.round((now.getDate() / dim) * 100),
    });
  }
  if (yearProjection) {
    const now = new Date();
    const yr = now.getFullYear();
    const target =
      stravaYearlyGoal && stravaYearlyGoal > 0
        ? stravaYearlyGoal
        : Math.round((yearProjection.projectedKm || 0) / 100) * 100 || 100;
    const cur = yearProjection.ytdKm || 0;
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const diy = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0 ? 366 : 365;
    goals.push({
      name: `${yr} distance goal`,
      short: "Y",
      current: cur,
      target,
      unit: "km",
      pct: target > 0 ? Math.round((cur / target) * 100) : 0,
      expectedPct: Math.round((doy / diy) * 100),
    });
  }
  return goals;
}

function openGoalsModal() {
  const goals = buildGoals();
  const body = document.getElementById("stat-info-body");
  if (!goals.length) {
    body.innerHTML = `<div class="empty">No goal data yet — log a few runs first.</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const rows = goals
    .map((g) => {
      const behind = g.pct < g.expectedPct - 5;
      const remaining = Math.max(g.target - g.current, 0);
      return `
      <div class="goal-row">
        <div class="goal-head">
          <span class="goal-name">${g.name}</span>
          <span class="goal-nums">${fmtKm(g.current)} / ${g.target} ${g.unit}</span>
        </div>
        <div class="goal-bar">
          <span class="goal-fill${behind ? " behind" : ""}" style="width:${Math.min(g.pct, 100)}%"></span>
          <span class="goal-expected" style="left:${Math.min(g.expectedPct, 100)}%" title="Where you should be by now"></span>
        </div>
        <div class="goal-foot">${g.pct}% · ${
        remaining > 0 ? `${fmtKm(remaining)} ${g.unit} to go` : "achieved 🎉"
      } · ${behind ? "behind pace" : "on pace"}</div>
      </div>`;
    })
    .join("");
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">🏅</span>
      <div>
        <div class="si-title">Goals &amp; progress</div>
        <div class="coach-summary">Auto-set from your combined Garmin + Strava running.</div>
      </div>
    </div>
    <div class="goal-list">${rows}</div>
    <div class="si-tip">💡 Targets are derived from your recent training. The marker on each bar shows where you should be by today.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openGearModal() {
  const gear = stravaGear;
  const body = document.getElementById("stat-info-body");
  if (!gear || !gear.shoes || !gear.shoes.length) {
    body.innerHTML = `<div class="empty">No Strava gear found. Add shoes to your activities in Strava to track mileage.</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const active = gear.active;
  const shoeRow = (s) => {
    const isActive = active && s.id === active.id;
    return `
      <div class="coach-signal ${isActive ? "good" : ""}">
        <div class="cs-lab">${s.name}${isActive ? ' <span class="assess good">Active</span>' : ""}</div>
        <div class="cs-val">${s.km.toLocaleString()} km</div>
      </div>`;
  };

  const activeShoes = gear.shoes.filter((s) => !s.retired);
  const retiredShoes = gear.shoes.filter((s) => s.retired);
  // Active/most-used shoe first, then the rest by mileage.
  activeShoes.sort((a, b) => {
    if (active) {
      if (a.id === active.id) return -1;
      if (b.id === active.id) return 1;
    }
    return b.km - a.km;
  });

  let sections = "";
  if (activeShoes.length) {
    sections += `<div class="tr-heading">Active shoes</div><div class="coach-signals">${activeShoes
      .map(shoeRow)
      .join("")}</div>`;
  }
  if (retiredShoes.length) {
    sections += `<div class="tr-heading" style="margin-top:16px">Retired shoes</div><div class="coach-signals">${retiredShoes
      .map(shoeRow)
      .join("")}</div>`;
  }

  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">👟</span>
      <div>
        <div class="si-title">${active ? active.name : "Gear"}</div>
        <div class="coach-summary">${active ? `${active.km.toLocaleString()} km on your active shoe` : ""}</div>
      </div>
    </div>
    ${sections}
    <div class="si-tip">💡 Shoe mileage comes from Strava (active and retired shoes shown). Most running shoes last ~500–800 km — plan a replacement as you approach that.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openLactateModal() {
  const lt = lactateThreshold;
  const body = document.getElementById("stat-info-body");
  if (!lt || (!lt.hr && !lt.paceMinPerKm)) {
    body.innerHTML = `<div class="empty">No lactate threshold data from Garmin yet. It's auto-detected during harder guided runs.</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const rows = `
    <div class="coach-signal">
      <div class="cs-lab">Threshold heart rate</div>
      <div class="cs-val">${lt.hr ? `${lt.hr} bpm` : "—"}</div>
    </div>
    <div class="coach-signal">
      <div class="cs-lab">Threshold pace</div>
      <div class="cs-val">${lt.paceMinPerKm ? fmtPace(lt.paceMinPerKm) : "—"}</div>
    </div>`;
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">🩸</span>
      <div>
        <div class="si-title">Lactate threshold</div>
        <div class="coach-summary">The intensity where fatigue starts to build rapidly — your tempo/threshold effort.</div>
      </div>
    </div>
    <div class="coach-signals">${rows}</div>
    <div class="si-tip">💡 Garmin detects this during harder runs. Run tempo intervals around this HR/pace to raise your threshold over time.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openStreakPopup() {
  const st = stravaStreak;
  const body = document.getElementById("stat-info-body");
  const n = st ? st.weeks : 0;
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">🔥</span>
      <div>
        <div class="si-title">${n} week${n === 1 ? "" : "s"} streak</div>
        <div class="coach-summary">${
          st && st.thisWeekActive
            ? "You've run this week — your streak is safe."
            : "No run logged this week yet. Get one in to keep the streak alive."
        }</div>
      </div>
    </div>
    <div class="si-tip">💡 A "week streak" counts consecutive calendar weeks (Mon–Sun) with at least one Strava run.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function renderRunningReport(r) {
  const cards = document.getElementById("report-cards");
  if (cards) {
    const proj = r.projection;
    const projCard = proj
      ? `
      <div class="report-card projection" title="Projected total for ${r.year.label} — the remaining days estimated at your recent 60-day pace, blended with your year-to-date rate.">
        <div class="rc-label">Projected ${r.year.label}</div>
        <div class="rc-km">${proj.projectedKm.toLocaleString()} <span>km</span></div>
        <div class="rc-sub">≈ ${proj.onPacePerMonth}/mo pace</div>
      </div>`
      : "";
    cards.innerHTML = `
      <div class="report-card">
        <div class="rc-label">This month · ${r.month.label}</div>
        <div class="rc-km">${r.month.km} <span>km</span></div>
        <div class="rc-sub">${r.month.count} run${r.month.count === 1 ? "" : "s"}</div>
      </div>
      <div class="report-card year">
        <div class="rc-label">This year · ${r.year.label}</div>
        <div class="rc-km">${r.year.km} <span>km</span></div>
        <div class="rc-sub">${r.year.count} run${r.year.count === 1 ? "" : "s"}</div>
      </div>
      ${projCard}`;
  }
  reportData.monthly = r.monthly || [];
  reportData.weekly = r.weekly || [];
  weeklyProgress = r.weeklyProgress || null;
  yearProjection = r.projection || null;
  runMonthKm = r.month ? r.month.km : null;
  renderStatCards(); // refresh the "This week" card now that progress is known
  renderMileageChart();
}

function renderMileageChart() {
  const canvas = document.getElementById("mileage-chart");
  if (!canvas) return;
  const wrap = canvas.closest(".run-chart-wrap");
  if (wrap) wrap.classList.remove("skeleton");

  let labels, data, highlight, axisText;
  if (mileageMode === "weekly") {
    labels = reportData.weekly.map((w) => w.week);
    data = reportData.weekly.map((w) => w.km);
    highlight = data.length - 1; // current week
    axisText = "km per week";
  } else {
    labels = reportData.monthly.map((m) => m.month);
    data = reportData.monthly.map((m) => m.km);
    highlight = new Date().getMonth(); // current month (0-based)
    axisText = "km per month";
  }

  if (mileageChart) mileageChart.destroy();
  mileageChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "km",
          data,
          backgroundColor: labels.map((_, i) =>
            i === highlight ? "#38bdf8" : "#2dd4bf"
          ),
          borderRadius: 5,
        },
      ],
    },
    plugins: [
      {
        // Draw each bar's distance value above it by default.
        id: "mileageLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          meta.data.forEach((bar, i) => {
            const val = chart.data.datasets[0].data[i];
            if (!val) return;
            ctx.save();
            ctx.fillStyle = "#e8eef9";
            ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(val, bar.x, bar.y - 3);
            ctx.restore();
          });
        },
      },
    ],
    options: {
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        openMileageRange(elements[0].index);
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.y} km (click for runs)` } },
      },
      scales: {
        x: { ticks: { color: "#9fb0cc" }, grid: { display: false } },
        y: {
          ticks: { color: "#9fb0cc", callback: (v) => `${v}` },
          grid: { color: "#243450" },
          title: { display: true, text: axisText, color: "#9fb0cc" },
        },
      },
    },
  });
}

function openMileageRange(index) {
  if (mileageMode === "weekly") {
    const w = reportData.weekly[index];
    if (!w || !w.weekStart) return;
    const start = w.weekStart;
    const end = new Date(new Date(start).getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);
    openRangeActivities(start, end, `Week of ${w.week}`);
  } else {
    const year = new Date().getFullYear();
    const m = index + 1;
    const start = `${year}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(year, m, 0).getDate();
    let end = `${year}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const todayStr = new Date().toISOString().slice(0, 10);
    if (end > todayStr) end = todayStr;
    const monthName = reportData.monthly[index]?.month || "";
    openRangeActivities(start, end, `${monthName} ${year}`);
  }
}

function renderRunningInsights(d) {
  // Personal records
  const prCards = document.getElementById("pr-cards");
  if (prCards) {
    let cards = (d.records || [])
      .map(
        (r) => `
        <div class="pr-card${r.activityId ? " clickable" : ""}" data-id="${r.activityId || ""}">
          <div class="pr-dist">${r.label}</div>
          <div class="pr-time">${fmtClock(r.timeSec)}</div>
          <div class="pr-date">${r.date ? shortDate(r.date) : ""}</div>
        </div>`
      )
      .join("");
    if (d.longestRun) {
      cards += `
        <div class="pr-card${d.longestRun.activityId ? " clickable" : ""}" data-id="${d.longestRun.activityId || ""}">
          <div class="pr-dist">Longest run</div>
          <div class="pr-time">${d.longestRun.km} km</div>
          <div class="pr-date">${d.longestRun.date ? shortDate(d.longestRun.date) : ""}</div>
        </div>`;
    }
    prCards.innerHTML = cards || `<div class="empty">No records yet.</div>`;
    prCards.querySelectorAll(".pr-card.clickable").forEach((el) => {
      el.addEventListener("click", () => openActivityModal(el.dataset.id));
    });
  }

  // Race predictions
  const note = document.getElementById("pred-note");
  if (note) note.textContent = d.predictionBasis || "";
  const predCards = document.getElementById("pred-cards");
  if (predCards) {
    predCards.innerHTML =
      (d.predictions || [])
        .map(
          (p) => `
        <div class="pred-card">
          <div class="pred-label">${p.label}</div>
          <div class="pred-time">${fmtClock(p.timeSec)}</div>
        </div>`
        )
        .join("") || `<div class="empty">Not enough data to predict.</div>`;
  }
}

function renderStatCards(s) {
  if (s) dashSummary = s;
  renderStatCardsImpl(dashSummary || {});
  return;
  // eslint-disable-next-line no-unreachable
  const km = s.totalDistanceMeters ? (s.totalDistanceMeters / 1000).toFixed(2) : null;
  const sleepH = s.sleepingSeconds ? (s.sleepingSeconds / 3600).toFixed(1) : null;
  const cards = [
    { icon: "�", value: km ? `${km} km` : "–", label: "Distance today" },
    { icon: "🔥", value: num(s.totalCalories), label: "Total calories", sub: s.activeCalories ? `${num(s.activeCalories)} active` : "" },
    { icon: "❤️", value: num(s.restingHeartRate), label: "Resting HR", sub: s.maxHeartRate ? `Max ${num(s.maxHeartRate)}` : "" },
    { icon: "⚡", value: num(s.intensityMinutes), label: "Intensity min" },
    { icon: "🔋", value: s.bodyBatteryHighest != null ? `${num(s.bodyBatteryLowest)}–${num(s.bodyBatteryHighest)}` : "–", label: "Body battery" },
    { icon: "😴", value: sleepH ? `${sleepH} h` : "–", label: "Sleep" },
  ];

  const keys = ["distance", "calories", "restingHR", "intensity", "bodyBattery", "sleep"];
  document.getElementById("stat-cards").innerHTML = cards
    .map(
      (c, idx) => `
      <div class="stat clickable" data-key="${keys[idx]}">
        <span class="icon">${c.icon}</span>
        <div class="stat-body">
          <div class="value">${c.value}</div>
          <div class="label">${c.label}</div>
          ${c.sub ? `<div class="sub">${c.sub}</div>` : ""}
        </div>
        <span class="stat-info">ⓘ</span>
      </div>`
    )
    .join("");

  document.querySelectorAll(".stat.clickable").forEach((el) => {
    el.addEventListener("click", () => openStatInfo(el.dataset.key));
  });
}

function renderStatCardsImpl(sum) {
  const km = sum.totalDistanceMeters ? (sum.totalDistanceMeters / 1000).toFixed(2) : null;
  const sleepH = sum.sleepingSeconds ? (sum.sleepingSeconds / 3600).toFixed(1) : null;
  const wp = weeklyProgress;

  const calSub = sum.totalCalories
    ? `🔥 ${num(sum.totalCalories)} kcal${sum.activeCalories ? ` · ${num(sum.activeCalories)} active` : ""}`
    : "";

  const defaultCards = [
    (() => {
      const rp = racePrediction;
      const rows = rp && rp.rows ? rp.rows : [];
      const tenK = rows.find((r) => r.label === "10K");
      const headVal = tenK ? (tenK.garminSec != null ? tenK.garminSec : tenK.stravaSec) : null;
      const parts = [];
      if (rp && rp.hasGarmin) parts.push("Garmin");
      if (rp && rp.hasStrava) parts.push("Strava");
      return {
        key: "race",
        icon: "🏁",
        value: headVal ? fmtClock(headVal) : "…",
        label: "Predicted 10K",
        sub: parts.join(" · "),
        special: "race",
      };
    })(),
    ...(stravaConnected
      ? [
          ...(stravaGear && stravaGear.active
            ? [
                (() => {
                  const g = stravaGear.active;
                  return {
                    key: "gear",
                    icon: "👟",
                    value: `${g.km.toLocaleString()} km`,
                    label: "Active shoe",
                    sub: g.name,
                    special: "gear",
                  };
                })(),
              ]
            : []),
          (() => {
            const goals = buildGoals();
            const onTrack = goals.filter((g) => g.pct >= g.expectedPct - 5).length;
            return {
              key: "goals",
              icon: "🏅",
              label: "Goals",
              sub: goals.length ? `${onTrack}/${goals.length} on track` : "Set a goal",
              special: "goals",
              goals,
            };
          })(),
          (() => {
            const st = stravaStreak;
            const n = st ? st.weeks : 0;
            return {
              key: "streak",
              icon: "🔥",
              value: st ? `${n} wk` : "…",
              label: "Run streak",
              sub: st ? (st.thisWeekActive ? "active this week" : "log a run to extend") : "",
              special: "streak",
            };
          })(),
        ]
      : []),
    { key: "restingHR", icon: "❤️", value: num(sum.restingHeartRate), label: "Resting HR", sub: sum.maxHeartRate ? `Max ${num(sum.maxHeartRate)}` : "" },
  ];

  const extraCards = [
    { key: "intensity", icon: "⚡", value: num(sum.intensityMinutes), label: "Intensity min" },
    (() => {
      // Combined Training tile: status + readiness score + lactate threshold.
      const g = guidanceData;
      const r = readinessData;
      const lt = lactateThreshold;
      const level = (r && r.level) || (g && g.level);
      const icon = !r ? "🧭" : r.level === "good" ? "💪" : r.level === "watch" ? "⚠️" : "🧭";
      const short = g ? g.status.split(" — ")[0] : r ? r.headline : "…";
      const thr = lt && lt.paceMinPerKm ? fmtPace(lt.paceMinPerKm) : lt && lt.hr ? `${lt.hr} bpm` : null;
      const subParts = [short];
      if (thr) subParts.push(`LT ${thr}`);
      return {
        key: "training",
        icon,
        value: r && r.score != null ? `${r.score}/100` : short,
        label: "Training",
        sub: subParts.join(" · "),
        special: "training",
        level,
      };
    })(),
    { key: "bodyBattery", icon: "🔋", value: sum.bodyBatteryHighest != null ? `${num(sum.bodyBatteryLowest)}–${num(sum.bodyBatteryHighest)}` : "–", label: "Body battery" },
    { key: "sleep", icon: "😴", value: sleepH ? `${sleepH} h` : "–", label: "Sleep" },
  ];

  const card = (c, extra = false) => {
    if (c.special === "goals") {
      const bars = (c.goals || [])
        .map(
          (g) => `
          <div class="gm-row">
            <span class="gm-lab">${g.short}</span>
            <span class="gm-bar"><span class="gm-fill${g.pct >= g.expectedPct - 5 ? "" : " behind"}" style="width:${Math.min(g.pct, 100)}%"></span></span>
            <span class="gm-pct">${g.pct}%</span>
          </div>`
        )
        .join("");
      const inner = c.goals && c.goals.length ? `<div class="goals-mini">${bars}</div>` : `<div class="value">…</div>`;
      return `
      <div class="stat clickable" data-key="${c.key}" data-special="goals">
        <span class="icon">${c.icon}</span>
        <div class="stat-body">
          ${inner}
          <div class="label">${c.label}${c.sub ? ` · ${c.sub}` : ""}</div>
        </div>
        <span class="stat-info">ⓘ</span>
      </div>`;
    }
    return `
      <div class="stat clickable${extra ? " stat-extra" : ""}" data-key="${c.key}"${c.special ? ` data-special="${c.special}"` : ""}>
        <span class="icon">${c.icon}</span>
        <div class="stat-body">
          <div class="value${c.level ? ` lv-${c.level}` : ""}">${c.value}</div>
          <div class="label">${c.label}</div>
          ${c.sub ? `<div class="sub">${c.sub}</div>` : ""}
        </div>
        <span class="stat-info">ⓘ</span>
      </div>`;
  };

  const container = document.getElementById("stat-cards");

  // Render up to two rows; if more tiles remain, offer a "Show more" toggle.
  const allCards = [...defaultCards, ...extraCards];
  const width = container.clientWidth || window.innerWidth || 1000;
  const gap = 8;
  const minTile = 158;
  const cols = Math.max(1, Math.floor((width + gap) / (minTile + gap)));
  const twoRows = cols * 2;
  const total = allCards.length;

  let visible = total;
  let showToggle = false;
  if (total > twoRows) {
    showToggle = true;
    visible = showAllStats ? total : twoRows;
  }

  container.innerHTML = allCards.slice(0, visible).map((c) => card(c)).join("");

  container.querySelectorAll(".stat.clickable").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.special === "weekly") openWeeklyPopup();
      else if (el.dataset.special === "coach") openCoachModal();
      else if (el.dataset.special === "readiness") openReadinessModal();
      else if (el.dataset.special === "trainreadi") openTrainReadiModal();
      else if (el.dataset.special === "training") openTrainingModal();
      else if (el.dataset.special === "race") openRacePredictionPopup();
      else if (el.dataset.special === "projection") openProjectionPopup();
      else if (el.dataset.special === "lactate") openLactateModal();
      else if (el.dataset.special === "gear") openGearModal();
      else if (el.dataset.special === "streak") openStreakPopup();
      else if (el.dataset.special === "goals") openGoalsModal();
      else openStatInfo(el.dataset.key);
    });
  });

  // Show/hide + label the toggle placed below the grid.
  const wrap = document.querySelector(".stat-toggle-wrap");
  const toggle = document.getElementById("stat-toggle");
  if (wrap) wrap.classList.toggle("hidden", !showToggle);
  if (toggle) {
    toggle.textContent = showAllStats ? "Show less" : "Show more";
    toggle.onclick = () => {
      showAllStats = !showAllStats;
      renderStatCardsImpl(dashSummary || {});
    };
  }
}

// ------------------------------------------------ weekly mileage popup

function openProjectionPopup() {
  const p = yearProjection;
  const year = new Date().getFullYear();
  const body = document.getElementById("stat-info-body");
  if (!p) {
    body.innerHTML = `<div class="empty">Projection still loading…</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const remainingKm = Math.max(0, p.projectedKm - Math.round(p.ytdKm));
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">🎯</span>
      <div>
        <div class="si-title">Projected ${year} mileage</div>
        <div class="si-value">${p.projectedKm.toLocaleString()} km</div>
      </div>
    </div>
    <div class="wk-grid">
      <div><div class="wk-v">${Math.round(p.ytdKm).toLocaleString()} km</div><div class="wk-l">So far this year</div></div>
      <div><div class="wk-v">${remainingKm.toLocaleString()} km</div><div class="wk-l">Projected remaining</div></div>
      <div><div class="wk-v">${p.recentPacePerWeek} km</div><div class="wk-l">Recent pace / week</div></div>
      <div><div class="wk-v">${p.remainingDays}</div><div class="wk-l">Days left in year</div></div>
    </div>
    <div class="si-section"><h4>How it's calculated</h4><p>The remaining ${p.remainingDays} days are estimated at your <strong>recent 60-day pace</strong> (${p.recentPacePerWeek} km/week), blended 70/30 with your year-to-date rate — so it tracks your current training level rather than a flat yearly average.</p></div>
    <div class="si-tip">💡 Keep up your recent volume to land near ${p.projectedKm.toLocaleString()} km. Ramp it (safely) to beat it.</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function openWeeklyPopup() {
  const wp = weeklyProgress;
  const body = document.getElementById("stat-info-body");
  if (!wp) {
    body.innerHTML = `<div class="empty">Weekly data still loading…</div>`;
    document.getElementById("stat-info-modal").classList.remove("hidden");
    return;
  }
  const pct = wp.targetKm ? Math.min(100, Math.round((wp.currentKm / wp.targetKm) * 100)) : 0;
  const level = wp.deviationKm >= 2 ? "good" : wp.deviationKm <= -5 ? "watch" : "ok";
  const badge = `<span class="assess ${level}">${level === "good" ? "Ahead" : level === "watch" ? "Behind" : "On track"}</span>`;
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">📅</span>
      <div>
        <div class="si-title">This week's mileage</div>
        <div class="si-value">${wp.currentKm} / ${wp.targetKm} km ${badge}</div>
      </div>
    </div>
    <div class="wk-bar"><div class="wk-fill" style="width:${pct}%"></div></div>
    <div class="wk-grid">
      <div><div class="wk-v">${wp.targetKm} km</div><div class="wk-l">Weekly target</div></div>
      <div><div class="wk-v">${wp.remainingKm} km</div><div class="wk-l">Remaining</div></div>
      <div><div class="wk-v">${wp.expectedSoFarKm} km</div><div class="wk-l">Expected by today</div></div>
      <div><div class="wk-v">${wp.deviationKm >= 0 ? "+" : ""}${wp.deviationKm} km</div><div class="wk-l">Deviation</div></div>
    </div>
    <div class="si-section"><h4>Your reading</h4><p>${wp.status}</p></div>
    <div class="si-section"><h4>How the target is set</h4><p>Your target (${wp.targetKm} km) is your recent 4-week average (${wp.avg4Km} km), rounded to the nearest 10 km — skipping unusually low weeks. Baseline weeks used: ${wp.baselineWeeks.join(", ")} km.</p></div>
    <div class="si-tip">💡 Keep weekly jumps under ~10% to build mileage safely. <button class="btn-link" id="wk-view-runs">View this week's runs →</button></div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
  const viewBtn = document.getElementById("wk-view-runs");
  if (viewBtn) {
    viewBtn.addEventListener("click", () => {
      closeStatInfo();
      const start = wp.weekStart;
      const end = new Date(new Date(start).getTime() + 6 * 86400000)
        .toISOString()
        .slice(0, 10);
      openRangeActivities(start, end, "This week's runs");
    });
  }
}

// ------------------------------------------- activities-in-range modal

function openRangeActivities(start, end, title) {
  const modal = document.getElementById("range-modal");
  modal.classList.remove("hidden");
  document.querySelector("#range-modal .modal-head h2").textContent = title || "Activities";
  document.getElementById("range-modal-body").innerHTML =
    `<div class="empty">Loading activities…</div>`;
  api(`/api/activities?start=${start}&end=${end}`)
    .then((d) => {
      const acts = d.activities || [];
      const body = document.getElementById("range-modal-body");
      if (!acts.length) {
        body.innerHTML = `<div class="empty">No activities in this period.</div>`;
        return;
      }
      const totalKm = acts.reduce((t, a) => t + (a.distanceKm || 0), 0);
      body.innerHTML =
        `<div class="range-summary">${acts.length} activities · ${totalKm.toFixed(1)} km total</div>` +
        `<div class="activities">${acts.map(activityRowHtml).join("")}</div>`;
      body.querySelectorAll(".activity.clickable").forEach((el) => {
        el.addEventListener("click", () => {
          closeRangeModal();
          openActivityModal(el.dataset.id);
        });
      });
    })
    .catch((ex) => {
      document.getElementById("range-modal-body").innerHTML =
        `<div class="empty">Could not load: ${ex.message}</div>`;
    });
}

function closeRangeModal() {
  document.getElementById("range-modal").classList.add("hidden");
}

// ---------------------------------------------------- stat info modal

function openStatInfo(key) {
  const s = dashSummary || {};
  const info = metricInfo(key, s);
  if (!info) return;
  const body = document.getElementById("stat-info-body");
  const badge = info.level
    ? `<span class="assess ${info.level}">${info.assessLabel}</span>`
    : "";
  body.innerHTML = `
    <div class="si-head">
      <span class="si-icon">${info.icon}</span>
      <div>
        <div class="si-title">${info.title}</div>
        <div class="si-value">${info.valueText} ${badge}</div>
      </div>
    </div>
    <div class="si-section"><h4>What it is</h4><p>${info.what}</p></div>
    <div class="si-section"><h4>Why it matters for running</h4><p>${info.helpful}</p></div>
    ${info.assessment ? `<div class="si-section"><h4>Your reading</h4><p>${info.assessment}</p></div>` : ""}
    <div class="si-tip">💡 ${info.tip}</div>
  `;
  document.getElementById("stat-info-modal").classList.remove("hidden");
}

function closeStatInfo() {
  document.getElementById("stat-info-modal").classList.add("hidden");
}

// Returns metric explanation + a good/ok/watch assessment based on the value.
function metricInfo(key, s) {
  const km = s.totalDistanceMeters ? s.totalDistanceMeters / 1000 : null;
  const sleepH = s.sleepingSeconds ? s.sleepingSeconds / 3600 : null;

  switch (key) {
    case "distance":
      return {
        icon: "📏",
        title: "Distance today",
        valueText: km != null ? `${km.toFixed(2)} km` : "No distance logged",
        what: "The total distance you've covered today across all activities.",
        helpful:
          "Daily distance builds your weekly mileage — the single biggest driver of endurance and marathon readiness. Consistency matters more than any single big day.",
        assessment:
          km == null || km === 0
            ? "Nothing logged yet today — an easy run still counts toward your base."
            : "Keep your daily distance aligned with your weekly plan so mileage rises gradually (~10% per week).",
        tip: "Build long-run distance slowly; sudden jumps are the top cause of running injuries.",
      };
    case "calories": {
      const total = s.totalCalories;
      const active = s.activeCalories;
      return {
        icon: "🔥",
        title: "Calories burned today",
        valueText: total != null ? `${num(total)} kcal` : "–",
        what:
          "Total calories burned today — your resting metabolism plus everything you did. The 'active' part is what you burned through movement and exercise.",
        helpful:
          "Running burns a lot of energy. Under-fuelling high-calorie training days hurts recovery and performance, so use this to eat enough (especially carbs) around hard sessions.",
        assessment: active
          ? `About ${num(active)} kcal came from activity today.`
          : "",
        tip: "Refuel within 30–60 min after long or hard runs with carbs + protein to speed recovery.",
      };
    }
    case "restingHR": {
      const v = s.restingHeartRate;
      let level = "ok", label = "Average", note = "";
      if (v == null) {
        level = null;
      } else if (v < 50) {
        level = "good"; label = "Excellent";
        note = "Typical of well-trained endurance athletes — a strong, efficient heart.";
      } else if (v < 60) {
        level = "good"; label = "Very good";
        note = "Good aerobic fitness. Keep building your easy-run base.";
      } else if (v < 70) {
        level = "ok"; label = "Good";
        note = "Solid, around average. More easy aerobic running will lower it over time.";
      } else {
        level = "watch"; label = "Room to improve";
        note = "On the higher side. More easy mileage, better sleep and lower stress typically bring it down.";
      }
      return {
        icon: "❤️",
        title: "Resting heart rate",
        valueText: v != null ? `${num(v)} bpm` : "–",
        what:
          "Your heart rate at complete rest — one of the best simple markers of cardiovascular fitness and recovery.",
        helpful:
          "Lower usually means a fitter, more efficient heart. A resting HR that trends upward over days often signals fatigue, stress, dehydration or illness — a cue to take it easy.",
        assessment: note,
        level,
        assessLabel: label,
        tip: "Watch the trend, not one number. A jump of 5–7 bpm above your norm = prioritise recovery.",
      };
    }
    case "floors":
      return {
        icon: "🏢",
        title: "Floors climbed",
        valueText: s.floorsAscended != null ? `${num(s.floorsAscended)} floors` : "–",
        what: "Flights of stairs / elevation climbed today (~3 m each).",
        helpful:
          "Climbing and hilly running build leg strength and running economy, which translates to stronger finishes and better race-day resilience.",
        assessment: "",
        tip: "Add one hilly run or hill repeats weekly to boost power without extra pounding.",
      };
    case "intensity": {
      const v = s.intensityMinutes || 0;
      let level = "ok", label = "On track";
      if (v >= 30) { level = "good"; label = "Great"; }
      else if (v === 0) { level = "watch"; label = "None yet"; }
      return {
        icon: "⚡",
        title: "Intensity minutes",
        valueText: `${num(v)} min`,
        what:
          "Time spent in moderate-to-vigorous activity today (vigorous effort counts double).",
        helpful:
          "The WHO recommends 150 moderate (or 75 vigorous) intensity minutes per week for health. Runners usually exceed this — it confirms your sessions are hitting real training zones.",
        assessment:
          v === 0
            ? "No intensity minutes yet today — even a brisk 20-min effort adds up."
            : "Aim for 150+ across the week; mix easy volume with a couple of quality sessions.",
        level,
        assessLabel: label,
        tip: "Follow the 80/20 rule: ~80% easy running, ~20% at higher intensity.",
      };
    }
    case "bodyBattery": {
      const hi = s.bodyBatteryHighest;
      let level = "ok", label = "Moderate", note = "";
      if (hi == null) { level = null; }
      else if (hi >= 75) { level = "good"; label = "Well recharged";
        note = "You recharged well — a good day for a long run or a quality workout."; }
      else if (hi >= 50) { level = "ok"; label = "Moderate";
        note = "Reasonable reserves. Fine for easy or moderate running."; }
      else { level = "watch"; label = "Low";
        note = "Low reserves — prioritise easy running, hydration and sleep today."; }
      return {
        icon: "🔋",
        title: "Body Battery",
        valueText:
          s.bodyBatteryHighest != null
            ? `${num(s.bodyBatteryLowest)}–${num(s.bodyBatteryHighest)} / 100`
            : "–",
        what:
          "An energy gauge (0–100) built from heart-rate variability, stress, sleep and activity. It shows the range between your lowest and highest today.",
        helpful:
          "Great for timing training: schedule hard sessions and long runs when it's high, and recovery when it's low. Helps you avoid pushing on empty.",
        assessment: note,
        level,
        assessLabel: label,
        tip: "If it barely recovers overnight, you're likely under-recovered — add an easy or rest day.",
      };
    }
    case "sleep": {
      let level = "ok", label = "Okay", note = "";
      if (sleepH == null) { level = null; }
      else if (sleepH >= 7) { level = "good"; label = "Good";
        note = "Solid sleep — this is when your body adapts to training and gets stronger."; }
      else if (sleepH >= 6) { level = "ok"; label = "A bit low";
        note = "Slightly short. Aim for 7–9 h, especially during heavy training."; }
      else { level = "watch"; label = "Too low";
        note = "Insufficient sleep slows recovery, dulls performance and raises injury risk."; }
      return {
        icon: "😴",
        title: "Sleep",
        valueText: sleepH != null ? `${sleepH.toFixed(1)} h` : "–",
        what: "How long you slept last night.",
        helpful:
          "Sleep is the most powerful recovery tool there is — training adaptations happen while you rest. 7–9 hours supports performance and lowers injury risk.",
        assessment: note,
        level,
        assessLabel: label,
        tip: "Protect sleep the night before and after long runs — it matters as much as the run itself.",
      };
    }
    default:
      return null;
  }
}

function renderVo2(vo2, training) {
  const panel = document.getElementById("vo2-panel");
  if (!garminConnected) {
    panel.innerHTML = `<div class="empty">VO₂ max, training status and readiness come from Garmin. Connect Garmin (top-right) to see them.</div>`;
    return;
  }
  const v = vo2 || {};
  const items = [
    { big: v.runningVo2Max ?? "–", cap: "Running VO₂ max", metric: "running" },
    { big: v.cyclingVo2Max ?? "–", cap: "Cycling VO₂ max", metric: "cycling" },
  ];

  let html = items
    .map(
      (i) => `
      <div class="vo2-item${i.metric ? " clickable" : ""}"${
        i.metric ? ` data-metric="${i.metric}"` : ""
      }>
        <div class="big">${i.big}</div>
        <div class="cap">${i.cap}</div>
        <div class="unit">ml/kg/min</div>
        ${i.metric ? `<span class="hint-click">click for trend ▸</span>` : ""}
      </div>`
    )
    .join("");

  // Training status as a clear, self-explanatory card.
  if (training && training.trainingStatus) {
    const key = String(training.trainingStatus).split("_")[0].toLowerCase();
    const info = TRAINING_STATUS[key] || {
      icon: "ℹ️",
      desc: "Your current training status based on recent load and intensity.",
    };
    html += `
      <div class="vo2-status">
        <div class="vs-head">
          <span class="vs-icon">${info.icon}</span>
          <div>
            <div class="vs-label">Training status</div>
            <div class="vs-value">${prettyLabel(training.trainingStatus)}</div>
          </div>
        </div>
        <div class="vs-desc">${info.desc}</div>
      </div>`;
  }

  html += `<button id="vo2-analyze-btn" class="btn-analyze">🔬 What improved my VO₂ max?</button>`;
  document.getElementById("vo2-panel").innerHTML = html;

  document.querySelectorAll(".vo2-item.clickable").forEach((el) => {
    el.addEventListener("click", () => openVo2Modal(el.dataset.metric));
  });
  const analyzeBtn = document.getElementById("vo2-analyze-btn");
  if (analyzeBtn) analyzeBtn.addEventListener("click", openVo2Analysis);
}

function activityRowHtml(a) {
  const date = a.startTime
    ? new Date(a.startTime.replace(" ", "T")).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const isStrava = a.source === "strava";
  const selectable = compareMode; // both Garmin and Strava can be compared
  const checked = compareSelection.has(String(a.activityId));
  const checkbox = compareMode
    ? `<div class="a-check"><input type="checkbox" class="cmp-check" ${
        checked ? "checked" : ""
      } aria-label="Select to compare" /></div>`
    : "";
  return `
      <div class="activity clickable${selectable ? " selectable" : ""}${
    checked ? " selected" : ""
  }" data-id="${a.activityId}"${
    isStrava ? ` data-source="strava" data-strava-id="${a.stravaId}"` : ""
  }>
        ${checkbox}
        <div class="a-icon">${sportIcon(a.type)}</div>
        <div>
          <div class="a-name">${a.name || a.type || "Activity"}${
    isStrava ? ' <span class="list-tag strava">Strava</span>' : ""
  }${
    a.tag && TAG_META[a.tag]
      ? ` <span class="list-tag ${TAG_META[a.tag].cls}">${TAG_META[a.tag].icon} ${TAG_META[a.tag].label}</span>`
      : ""
  }${
    a.hasIntervals ? ' <span class="list-tag interval">⚡ Interval</span>' : ""
  }${
    a.benefit
      ? ` <span class="list-tag benefit ${benefitClass(a.benefit)}">${prettyLabel(a.benefit)}</span>`
      : ""
  }</div>
          <div class="a-date">${date}</div>
        </div>
        <div class="metric"><div class="m-val">${a.distanceKm ?? "–"} km</div><div class="m-lab">Distance</div></div>
        <div class="metric"><div class="m-val">${fmtDuration(a.durationSec)}</div><div class="m-lab">Time</div></div>
        <div class="metric"><div class="m-val">${fmtPace(a.paceMinPerKm)}</div><div class="m-lab">Pace</div></div>
        <div class="metric"><div class="m-val">${a.averageHR ? num(a.averageHR) : "–"}</div><div class="m-lab">Avg HR</div></div>
      </div>`;
}

function renderActivities(filter) {
  const list = document.getElementById("activities-list");
  const countEl = document.getElementById("activities-count");
  let acts = mergedActivities();
  if (filter && filter !== "all") {
    acts = acts.filter((a) => {
      const type = (a.type || "").toLowerCase();
      return filter === "strength"
        ? type.includes("strength")
        : type.includes(filter);
    });
  }
  if (currentTagFilter && currentTagFilter !== "all") {
    acts = acts.filter((a) => a.tag === currentTagFilter);
  }

  if (countEl) {
    const stravaCount = acts.filter((a) => a.source === "strava").length;
    countEl.textContent = acts.length
      ? `Showing ${acts.length} activit${acts.length === 1 ? "y" : "ies"}` +
        (stravaCount ? ` · ${stravaCount} from Strava` : "")
      : "";
  }

  if (!acts.length) {
    list.innerHTML = `<div class="empty">No activities found.</div>`;
    return;
  }

  list.innerHTML = acts.map(activityRowHtml).join("");
  list.classList.toggle("compare-on", compareMode);

  document.querySelectorAll(".activity.clickable").forEach((el) => {
    el.addEventListener("click", () => {
      if (compareMode) {
        // In compare mode a click toggles selection (Garmin or Strava).
        toggleCompareSelection(el.dataset.id, el);
        return;
      }
      if (el.dataset.source === "strava") {
        if (el.dataset.stravaId) {
          window.open(`https://www.strava.com/activities/${el.dataset.stravaId}`, "_blank", "noopener");
        }
      } else {
        openActivityModal(el.dataset.id);
      }
    });
  });
}

// Combine Garmin + Strava activities. When a Garmin run matches a Strava one
// (same rough start time and distance), keep the Garmin row (for full detail)
// but adopt the Strava name and its activity tag (race / long run / workout),
// so those tags stay available for badges and filtering. Unmatched Strava
// activities are added as extras.
function mergedActivities() {
  if (!stravaConnected || !stravaActivities.length) return allActivities;

  const ts = (a) => (a.startTime ? new Date(a.startTime.replace(" ", "T")).getTime() : 0);
  const matchIdx = (a) =>
    stravaActivities.findIndex(
      (s) =>
        Math.abs(ts(s) - ts(a)) <= 30 * 60 * 1000 &&
        Math.abs((s.distanceKm || 0) - (a.distanceKm || 0)) <= 0.5
    );

  const usedStrava = new Set();
  const garmin = allActivities.map((g) => {
    const i = matchIdx(g);
    if (i >= 0) {
      usedStrava.add(i);
      const s = stravaActivities[i];
      // Carry over the Strava name + tag onto the (detailed) Garmin row.
      return { ...g, name: s.name || g.name, tag: g.tag || s.tag || null };
    }
    return g;
  });

  const extras = stravaActivities.filter((_, i) => !usedStrava.has(i));
  return [...garmin, ...extras].sort((a, b) => ts(b) - ts(a));
}

// --------------------------------------------------- multi-activity compare

function setCompareMode(on) {
  compareMode = on;
  if (!on) compareSelection.clear();
  // Swap the single "Compare" button for the Compare / Cancel button group.
  const btn = document.getElementById("compare-mode-btn");
  const actions = document.getElementById("compare-actions");
  if (btn) btn.classList.toggle("hidden", on);
  if (actions) actions.classList.toggle("hidden", !on);
  renderActivities(currentSportFilter);
  updateCompareBar();
}

function toggleCompareSelection(id, rowEl) {
  const key = String(id);
  if (compareSelection.has(key)) compareSelection.delete(key);
  else {
    if (compareSelection.size >= 6) {
      toast("You can compare up to 6 activities at once.");
      return;
    }
    compareSelection.add(key);
  }
  if (rowEl) {
    const selected = compareSelection.has(key);
    rowEl.classList.toggle("selected", selected);
    const cb = rowEl.querySelector(".cmp-check");
    if (cb) cb.checked = selected;
  }
  updateCompareBar();
}

function updateCompareBar() {
  const n = compareSelection.size;
  const runBtn = document.getElementById("compare-run");
  if (runBtn) {
    runBtn.disabled = n < 2;
    runBtn.textContent =
      n >= 2 ? `Compare (${n})` : n === 1 ? "Select 1 more" : "Compare";
  }
}

function openMultiCompareModal(ids) {
  const modal = document.getElementById("multi-compare-modal");
  const body = document.getElementById("multi-compare-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="empty">Loading ${ids.length} activities…</div>`;

  // The loaded list rows carry Garmin's best-effort (fastest split) times,
  // which the per-activity detail endpoint does not return.
  const listById = new Map(
    mergedActivities().map((a) => [String(a.activityId), a])
  );

  Promise.all(
    ids.map((id) => {
      const list = listById.get(String(id)) || null;
      const isStrava = String(id).startsWith("strava-") || (list && list.source === "strava");
      if (isStrava) {
        // Strava activities have no Garmin detail/laps endpoint; use list data.
        return Promise.resolve({ id, detail: null, laps: [], list });
      }
      return Promise.all([
        api(`/api/activities/${id}`).catch(() => null),
        api(`/api/activities/${id}/laps`).then((d) => d.laps || []).catch(() => []),
      ]).then(([detail, laps]) => ({ id, detail, laps, list }));
    })
  )
    .then((results) => {
      const items = results.filter((r) => r.detail || r.list);
      if (items.length < 2) {
        body.innerHTML = `<div class="empty">Could not load enough activities to compare.</div>`;
        return;
      }
      renderMultiCompare(items);
    })
    .catch((ex) => {
      body.innerHTML = `<div class="empty">Could not compare: ${ex.message}</div>`;
    });
}

function closeMultiCompareModal() {
  document.getElementById("multi-compare-modal").classList.add("hidden");
  multiCompareCharts.forEach((c) => c && c.destroy());
  multiCompareCharts = [];
}

// Palette for the compared activities (matches column accents & chart lines).
const COMPARE_COLORS = ["#2dd4bf", "#f59e0b", "#a78bfa", "#f87171", "#38bdf8", "#4ade80"];

// Aggregate lap data over the first `targetKm`, splitting the lap that crosses
// the mark so time / HR / cadence reflect exactly that distance.
function croppedLapAgg(laps, targetKm) {
  let cum = 0, t = 0, hrNum = 0, hrDen = 0, cadNum = 0, cadDen = 0, elev = 0;
  for (const l of laps) {
    const d = l.distanceKm || 0;
    if (!d) continue;
    const frac = cum + d > targetKm ? (targetKm - cum) / d : 1;
    if (frac <= 0) break;
    const dd = d * frac;
    t += (l.durationSec || 0) * frac;
    if (l.averageHR) { hrNum += l.averageHR * dd; hrDen += dd; }
    if (l.averageRunCadence) { cadNum += l.averageRunCadence * dd; cadDen += dd; }
    elev += (l.elevationGain || 0) * frac;
    cum += dd;
    if (cum >= targetKm - 1e-6) break;
  }
  const reached = cum >= targetKm - 0.05;
  return {
    timeSec: reached ? Math.round(t) : null,
    avgHR: hrDen ? Math.round(hrNum / hrDen) : null,
    avgCad: cadDen ? Math.round(cadNum / cadDen) : null,
    elev: Math.round(elev),
  };
}

// Keep only the laps within the first `maxKm` (the crossing lap kept whole) so
// the comparison charts aren't stretched out by longer activities.
function cropLapsToDistance(laps, maxKm) {
  const out = [];
  let cum = 0;
  for (const l of laps) {
    if (cum >= maxKm - 1e-6) break;
    out.push(l);
    cum += l.distanceKm || 0;
  }
  return out;
}

function renderMultiCompare(items) {
  const body = document.getElementById("multi-compare-body");

  // Precompute a normalized shape per activity for table + charts. Data comes
  // from the loaded list row (available for BOTH Garmin and Strava) enriched
  // with the Garmin detail summary when it exists (running dynamics, power…).
  const cols = items.map((it, i) => {
    const la = it.list || {};
    const s = (it.detail && it.detail.summary) || {};
    const type = (it.detail && it.detail.type) || la.type || "";
    const isStrava = la.source === "strava" || String(it.id).startsWith("strava-");
    const isFoot = ["running", "walking", "hiking"].some((t) => type.includes(t));
    const avgSpeed = la.averageSpeed || s.averageSpeed || 0;
    const startTime = la.startTime || s.startTimeLocal || null;
    return {
      color: COMPARE_COLORS[i % COMPARE_COLORS.length],
      name: la.name || (it.detail && it.detail.name) || prettyLabel(type) || "Activity",
      type,
      isFoot,
      source: isStrava ? "Strava" : "Garmin",
      date: startTime ? shortDate(startTime) : "",
      laps: it.laps || [],
      // Best-effort (fastest split) times in seconds (Garmin list only).
      best: la.bestEfforts || {},
      // Unified metrics — present for both sources where the data exists.
      distanceKm: la.distanceKm != null ? la.distanceKm : s.distance != null ? s.distance / 1000 : null,
      durationSec: la.durationSec != null ? la.durationSec : s.duration ?? null,
      avgPace: la.paceMinPerKm != null ? la.paceMinPerKm : avgSpeed ? (1000 / avgSpeed) / 60 : null,
      avgSpeedKmh: avgSpeed ? avgSpeed * 3.6 : null,
      avgHR: la.averageHR != null ? la.averageHR : s.averageHR ?? null,
      maxHR: la.maxHR != null ? la.maxHR : s.maxHR ?? null,
      avgCadence: la.averageCadence != null ? la.averageCadence : s.averageRunCadence ?? null,
      elevationGain: la.elevationGain != null ? la.elevationGain : s.elevationGain ?? null,
      calories: la.calories != null ? la.calories : s.calories ?? null,
      aerobicTE: la.aerobicTrainingEffect != null ? la.aerobicTrainingEffect : s.trainingEffect ?? null,
      anaerobicTE: la.anaerobicTrainingEffect != null ? la.anaerobicTrainingEffect : s.anaerobicTrainingEffect ?? null,
      // Garmin-detail-only metrics (blank for Strava).
      bestPace: s.maxSpeed ? (1000 / s.maxSpeed) / 60 : null,
      maxCadence: s.maxRunCadence ?? null,
      strideLength: s.strideLength ?? null,
      groundContact: s.groundContactTime ?? null,
      vertOsc: s.verticalOscillation ?? null,
      vertRatio: s.verticalRatio ?? null,
      avgPower: s.averagePower ?? null,
      trainingLoad: s.activityTrainingLoad ?? null,
    };
  });

  const anyFoot = cols.some((c) => c.isFoot);

  // ---- Normalise every activity to a common event distance ----------------
  // eventKm = the largest whole-km distance ALL selected activities reached
  // (min of each activity's floored km, e.g. 10.10 & 21.30 -> 10 km). Time,
  // pace, HR & cadence are then measured over just that first eventKm so
  // different-length runs compare fairly; the lap charts are cropped to it too.
  const floored = cols.map((c) => (c.distanceKm != null ? Math.floor(c.distanceKm) : null));
  const eventKm = floored.length && floored.every((e) => e != null) ? Math.min(...floored) : null;
  const useEvent = !!(eventKm && eventKm >= 1);

  cols.forEach((c) => {
    if (useEvent && c.laps.length) {
      const agg = croppedLapAgg(c.laps, eventKm);
      c.eventTimeSec = agg.timeSec != null ? agg.timeSec : c.durationSec;
      c.eventAvgHR = agg.avgHR != null ? agg.avgHR : c.avgHR;
      c.eventAvgCad = agg.avgCad != null ? agg.avgCad : c.avgCadence;
      c.eventElev = agg.elev != null ? agg.elev : c.elevationGain;
      c.eventEstimated = false;
      c.cropLaps = cropLapsToDistance(c.laps, eventKm);
    } else if (useEvent) {
      // No lap data (e.g. Strava): estimate first-eventKm time from average
      // pace and scale distance-based totals proportionally.
      const frac = c.distanceKm ? Math.min(1, eventKm / c.distanceKm) : 1;
      c.eventTimeSec = c.avgPace ? Math.round(c.avgPace * eventKm * 60) : null;
      c.eventAvgHR = c.avgHR;
      c.eventAvgCad = c.avgCadence;
      c.eventElev = c.elevationGain != null ? Math.round(c.elevationGain * frac) : null;
      c.eventEstimated = true;
      c.cropLaps = [];
    } else {
      // Distances can't be normalised — fall back to full-activity values.
      c.eventTimeSec = c.durationSec;
      c.eventAvgHR = c.avgHR;
      c.eventAvgCad = c.avgCadence;
      c.eventElev = c.elevationGain;
      c.eventEstimated = false;
      c.cropLaps = c.laps;
    }
    c.eventPace = c.eventTimeSec && useEvent ? c.eventTimeSec / 60 / eventKm : c.avgPace;
    c.eventSpeedKmh = c.eventPace ? 60 / c.eventPace : null;
  });

  const anyEstimated = cols.some((c) => c.eventEstimated);
  const evSuffix = useEvent ? ` · ${eventKm} km` : "";
  const eventNote = useEvent
    ? `Compared over the first <b>${eventKm} km</b> shared by all selected activities — time, pace, HR & cadence are for that distance, and the lap charts are cropped to it.${
        anyEstimated ? " <em>* estimated from average pace (no lap data).</em>" : ""
      }`
    : `Distances can't be lined up to a common event — showing full-activity values.`;

  // Metric definitions. lowerBetter marks metrics where a smaller value wins
  // (highlighted green). hideIfEmpty rows are dropped when no activity has the
  // value (e.g. Garmin-only running dynamics when comparing Strava activities).
  const metrics = [
    { label: "Source", raw: (c) => null, fmt: (c) => c.source },
    { label: "Date", raw: (c) => null, fmt: (c) => c.date || "–" },
    { label: "Full distance", raw: (c) => c.distanceKm, fmt: (c) => (c.distanceKm != null ? `${c.distanceKm.toFixed(2)} km` : "–"), higherBetter: true },
    { label: `Time${evSuffix}`, raw: (c) => c.eventTimeSec, fmt: (c) => (c.eventTimeSec ? fmtClock(c.eventTimeSec) + (c.eventEstimated ? " *" : "") : "–"), lowerBetter: true },
    { label: `Pace${evSuffix}`, raw: (c) => c.eventPace, fmt: (c) => (c.eventPace ? fmtPace(c.eventPace) : "–"), lowerBetter: true, footOnly: true },
    { label: "Avg speed", raw: (c) => c.eventSpeedKmh, fmt: (c) => (c.eventSpeedKmh ? `${c.eventSpeedKmh.toFixed(1)} km/h` : "–"), higherBetter: true },
    { label: "Best pace", raw: (c) => c.bestPace, fmt: (c) => (c.bestPace ? fmtPace(c.bestPace) : "–"), lowerBetter: true, footOnly: true, hideIfEmpty: true },
    { label: `Avg HR${evSuffix}`, raw: (c) => c.eventAvgHR, fmt: (c) => (c.eventAvgHR ? `${Math.round(c.eventAvgHR)} bpm` : "–"), lowerBetter: true },
    { label: "Max HR", raw: (c) => c.maxHR, fmt: (c) => (c.maxHR ? `${Math.round(c.maxHR)} bpm` : "–") },
    { label: `Avg cadence${evSuffix}`, raw: (c) => c.eventAvgCad, fmt: (c) => (c.eventAvgCad ? `${Math.round(c.eventAvgCad)} spm` : "–"), higherBetter: true, hideIfEmpty: true },
    { label: "Max cadence", raw: (c) => c.maxCadence, fmt: (c) => (c.maxCadence ? `${Math.round(c.maxCadence)} spm` : "–"), hideIfEmpty: true },
    { label: "Stride length", raw: (c) => c.strideLength, fmt: (c) => (c.strideLength ? `${Math.round(c.strideLength)} cm` : "–"), higherBetter: true, hideIfEmpty: true },
    { label: "Ground contact", raw: (c) => c.groundContact, fmt: (c) => (c.groundContact ? `${Math.round(c.groundContact)} ms` : "–"), lowerBetter: true, hideIfEmpty: true },
    { label: "Vert. oscillation", raw: (c) => c.vertOsc, fmt: (c) => (c.vertOsc ? `${c.vertOsc.toFixed(1)} cm` : "–"), lowerBetter: true, hideIfEmpty: true },
    { label: "Vert. ratio", raw: (c) => c.vertRatio, fmt: (c) => (c.vertRatio ? `${c.vertRatio.toFixed(1)} %` : "–"), lowerBetter: true, hideIfEmpty: true },
    { label: `Elevation gain${evSuffix}`, raw: (c) => c.eventElev, fmt: (c) => (c.eventElev != null ? `${Math.round(c.eventElev)} m` : "–"), hideIfEmpty: true },
    { label: "Avg power", raw: (c) => c.avgPower, fmt: (c) => (c.avgPower ? `${Math.round(c.avgPower)} W` : "–"), higherBetter: true, hideIfEmpty: true },
    { label: "Aerobic TE", raw: (c) => c.aerobicTE, fmt: (c) => (c.aerobicTE ? c.aerobicTE.toFixed(1) : "–"), higherBetter: true, hideIfEmpty: true },
    { label: "Anaerobic TE", raw: (c) => c.anaerobicTE, fmt: (c) => (c.anaerobicTE ? c.anaerobicTE.toFixed(1) : "–"), higherBetter: true, hideIfEmpty: true },
    { label: "Training load", raw: (c) => c.trainingLoad, fmt: (c) => (c.trainingLoad ? Math.round(c.trainingLoad) : "–"), hideIfEmpty: true },
    { label: "Calories (full)", raw: (c) => c.calories, fmt: (c) => (c.calories ? `${Math.round(c.calories)} kcal` : "–"), hideIfEmpty: true },
  ];

  // Best-cell index for a metric (green highlight), if a clear direction exists.
  const bestIdx = (m) => {
    if (!m.lowerBetter && !m.higherBetter) return -1;
    let best = -1;
    let bestVal = null;
    cols.forEach((c, i) => {
      const v = m.raw(c);
      if (v == null || isNaN(v)) return;
      if (bestVal == null || (m.lowerBetter ? v < bestVal : v > bestVal)) {
        bestVal = v;
        best = i;
      }
    });
    // Don't highlight when every value is equal.
    const distinct = cols.map((c) => m.raw(c)).filter((v) => v != null);
    if (distinct.length && distinct.every((v) => v === distinct[0])) return -1;
    return best;
  };

  const headCells = cols
    .map(
      (c) =>
        `<div class="mc-col-head"><span class="mc-dot" style="background:${c.color}"></span>
           <div class="mc-col-name" title="${escapeAttr(c.name)}">${c.name}</div>
           <div class="mc-col-date">${c.date}</div></div>`
    )
    .join("");

  const metricRow = (m) => {
    const best = bestIdx(m);
    const cells = cols
      .map(
        (c, i) =>
          `<div class="mc-cell${i === best ? " mc-best" : ""}">${m.fmt(c)}</div>`
      )
      .join("");
    return `<div class="mc-row"><div class="mc-metric">${m.label}</div>${cells}</div>`;
  };

  const rows = metrics
    .filter((m) => !(m.footOnly && !anyFoot))
    .filter((m) => !(m.hideIfEmpty && cols.every((c) => m.raw(c) == null)))
    .map(metricRow)
    .join("");

  // Best-effort (fastest split) times — Strava/Garmin style event distances.
  // Only distances that at least one activity actually reached are shown.
  const bestMetrics = [
    { label: "Best 1 km", key: "1000" },
    { label: "Best 1 mile", key: "1609" },
    { label: "Best 5 km", key: "5000" },
    { label: "Best 10 km", key: "10000" },
  ].map((m) => ({
    label: m.label,
    raw: (c) => c.best[m.key] || null,
    fmt: (c) => (c.best[m.key] ? fmtClock(c.best[m.key]) : "–"),
    lowerBetter: true,
  }));
  const shownBest = bestMetrics.filter((m) => cols.some((c) => m.raw(c) != null));
  const bestRows = shownBest.length
    ? `<div class="mc-row mc-subhead"><div class="mc-metric">Best efforts</div>${cols
        .map(() => `<div></div>`)
        .join("")}</div>${shownBest.map(metricRow).join("")}`
    : "";

  body.innerHTML = `
    <p class="mc-intro">Comparing <b>${cols.length}</b> activities. Green marks the best value in each row.</p>
    <p class="mc-event ${useEvent ? "same" : "mixed"}">📏 ${eventNote}</p>

    <div class="mc-chart-block">
      <h3>Lap pace &amp; heart rate</h3>
      <canvas id="mc-combined-chart" height="230"></canvas>
    </div>
    <p class="cmp-note">Solid lines = pace (left axis, higher = faster) · dashed lines = heart rate (right axis). Laps are cropped to the shared event distance.</p>

    <div class="mc-table" style="--mc-cols:${cols.length}">
      <div class="mc-row mc-head">
        <div class="mc-metric">Metric</div>
        ${headCells}
      </div>
      ${rows}
      ${bestRows}
    </div>
  `;

  renderMultiComboChart(cols);
}

function renderMultiComboChart(cols) {
  multiCompareCharts.forEach((c) => c && c.destroy());
  multiCompareCharts = [];

  // Use the event-cropped laps so a longer run doesn't stretch the x-axis.
  const lapsOf = (c) => c.cropLaps || c.laps || [];
  const maxLaps = Math.max(0, ...cols.map((c) => lapsOf(c).length));
  if (!maxLaps) return;
  const labels = Array.from({ length: maxLaps }, (_, i) => `Lap ${i + 1}`);

  // One chart, two y-axes: pace (left, reversed) and heart rate (right). Each
  // activity keeps its colour — solid line for pace, dashed for HR.
  const datasets = [];
  cols.forEach((c) => {
    const laps = lapsOf(c);
    if (laps.some((l) => l.paceMinPerKm)) {
      datasets.push({
        label: `${c.name} · pace`,
        data: laps.map((l) => (l.paceMinPerKm ? Number(l.paceMinPerKm.toFixed(2)) : null)),
        borderColor: c.color,
        backgroundColor: c.color,
        yAxisID: "yPace",
        spanGaps: true,
        tension: 0.25,
      });
    }
    if (laps.some((l) => l.averageHR)) {
      datasets.push({
        label: `${c.name} · HR`,
        data: laps.map((l) => l.averageHR || null),
        borderColor: c.color,
        backgroundColor: c.color,
        borderDash: [5, 4],
        pointStyle: "rectRot",
        yAxisID: "yHr",
        spanGaps: true,
        tension: 0.25,
      });
    }
  });
  if (!datasets.length) return;

  const canvas = document.getElementById("mc-combined-chart");
  if (!canvas) return;
  multiCompareCharts.push(
    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#e8eef9", boxWidth: 14, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                ctx.dataset.yAxisID === "yPace"
                  ? `${ctx.dataset.label}: ${fmtPace(ctx.parsed.y)}`
                  : `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} bpm`,
            },
          },
        },
        scales: {
          x: { ticks: { color: "#9fb0cc" }, grid: { display: false } },
          yPace: {
            position: "left",
            reverse: true, // faster pace (smaller number) shown higher
            title: { display: true, text: "Pace (min/km)", color: "#9fb0cc" },
            ticks: { color: "#9fb0cc", callback: (v) => fmtPace(v) },
            grid: { color: "#243450" },
          },
          yHr: {
            position: "right",
            title: { display: true, text: "Heart rate (bpm)", color: "#9fb0cc" },
            ticks: { color: "#9fb0cc" },
            grid: { drawOnChartArea: false },
          },
        },
      },
    })
  );
}

// --------------------------------------------------------- strava (extra source)

function updateConnectButtons() {
  const gBtn = document.getElementById("connect-garmin-btn");
  if (gBtn) gBtn.classList.toggle("hidden", garminConnected);
  // Analysis is Garmin-only; hide it for Strava-only logins.
  const aBtn = document.getElementById("open-analysis");
  if (aBtn) aBtn.classList.toggle("hidden", !garminConnected);
}

function setAvatar(url) {
  const img = document.getElementById("user-avatar");
  if (!img) return;
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
    img.onerror = () => img.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    img.removeAttribute("src");
  }
}

async function loadStravaStatus() {
  const btn = document.getElementById("strava-btn");
  try {
    const st = await api("/api/strava/status");
    stravaConnected = !!st.connected;
    stravaYearlyGoal = st.yearlyGoalKm != null ? st.yearlyGoalKm : null;
    if (st.connected && st.avatar) setAvatar(st.avatar);

    // Topbar button mirrors "Connect Garmin": shown only when Strava is
    // configured but not yet connected; hidden once connected.
    if (btn) {
      const showBtn = !!st.configured && !st.connected;
      btn.classList.toggle("hidden", !showBtn);
      btn.textContent = "🔗 Connect Strava";
    }

    if (st.connected) {
      await loadStravaActivities();
      api("/api/strava/extras")
        .then((e) => {
          stravaGear = e.gear || null;
          stravaStreak = e.streak || null;
          renderStatCards();
        })
        .catch(() => {});
    } else {
      stravaActivities = [];
      stravaGear = null;
      stravaStreak = null;
    }
  } catch (_) {
    if (btn) btn.classList.add("hidden");
  }
}

async function loadStravaActivities() {
  if (!stravaConnected) return;
  try {
    const q = currentActivityQuery; // e.g. days=30 or limit=50
    const res = await api(`/api/strava/activities?${q}`);
    stravaActivities = res.activities || [];
    renderActivities(currentSportFilter);
  } catch (_) {
    stravaActivities = [];
  }
}

function onStravaButton() {
  if (stravaConnected) {
    if (!confirm("Disconnect Strava? Your Strava activities will stop showing.")) return;
    api("/api/strava/disconnect", { method: "POST" })
      .then(() => {
        stravaConnected = false;
        stravaActivities = [];
        loadStravaStatus();
        renderActivities(currentSportFilter);
        toast("Strava disconnected");
      })
      .catch(() => toast("Could not disconnect Strava"));
  } else {
    // Full-page redirect to Strava's OAuth consent screen.
    window.location.href = "/api/strava/connect";
  }
}

// ----------------------------------------------------------- vo2 modal

function openVo2Modal(metric) {
  vo2CurrentMetric = metric || "running";
  const title = vo2CurrentMetric === "cycling" ? "Cycling" : "Running";
  document.querySelector("#vo2-modal .modal-head h2").textContent = `${title} VO₂ Max trend`;
  document.getElementById("vo2-modal").classList.remove("hidden");
  loadVo2History(vo2CurrentPeriod);
}

function closeVo2Modal() {
  document.getElementById("vo2-modal").classList.add("hidden");
  if (vo2Chart) {
    vo2Chart.destroy();
    vo2Chart = null;
  }
}

async function loadVo2History(period) {
  vo2CurrentPeriod = period;
  document.querySelectorAll("#vo2-periods button").forEach((b) => {
    b.classList.toggle("active", b.dataset.period === period);
  });
  try {
    const data = await api(`/api/vo2max/history?period=${period}`);
    renderVo2Chart(data.points || []);
  } catch (ex) {
    toast(`Error: ${ex.message}`);
  }
}

function renderVo2Chart(points) {
  const empty = document.getElementById("vo2-empty");
  const canvas = document.getElementById("vo2-chart");

  const series = points
    .map((p) => ({ date: p.date, value: p[vo2CurrentMetric] }))
    .filter((p) => p.value != null);

  if (!series.length) {
    empty.classList.remove("hidden");
    canvas.style.display = "none";
    if (vo2Chart) {
      vo2Chart.destroy();
      vo2Chart = null;
    }
    return;
  }
  empty.classList.add("hidden");
  canvas.style.display = "block";

  const labels = series.map((p) =>
    new Date(p.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  );
  const values = series.map((p) => p.value);

  if (vo2Chart) vo2Chart.destroy();
  vo2Chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "VO₂ max",
          data: values,
          borderColor: "#2dd4bf",
          backgroundColor: "rgba(45, 212, 191, 0.15)",
          fill: true,
          tension: 0.3,
          pointRadius: series.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#9fb0cc", maxTicksLimit: 8, autoSkip: true },
          grid: { display: false },
        },
        y: {
          ticks: { color: "#9fb0cc" },
          grid: { color: "#243450" },
          suggestedMin: Math.min(...values) - 2,
          suggestedMax: Math.max(...values) + 2,
        },
      },
    },
  });
}

document.getElementById("vo2-close").addEventListener("click", closeVo2Modal);
document.getElementById("vo2-modal").addEventListener("click", (e) => {
  if (e.target.id === "vo2-modal") closeVo2Modal();
});
document.querySelectorAll("#vo2-periods button").forEach((b) => {
  b.addEventListener("click", () => loadVo2History(b.dataset.period));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeVo2Modal();
});

// Combined Training (status · readiness · threshold) modal.
document.getElementById("training-close").addEventListener("click", closeTrainingModal);
document.getElementById("training-modal").addEventListener("click", (e) => {
  if (e.target.id === "training-modal") closeTrainingModal();
});
document.querySelectorAll("#training-periods button").forEach((b) => {
  b.addEventListener("click", () => loadTrainingHistory(b.dataset.period));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTrainingModal();
});

// ------------------------------------------------- vo2 analysis modal

let vo2AnalysisPeriod = "6m";

function openVo2Analysis() {
  document.getElementById("vo2-analysis-modal").classList.remove("hidden");
  loadVo2Analysis(vo2AnalysisPeriod);
}

function closeVo2Analysis() {
  document.getElementById("vo2-analysis-modal").classList.add("hidden");
}

function loadVo2Analysis(period) {
  vo2AnalysisPeriod = period;
  document.querySelectorAll("#vo2-analysis-periods button").forEach((b) => {
    b.classList.toggle("active", b.dataset.period === period);
  });
  document.getElementById("vo2-analysis-body").innerHTML =
    `<div class="empty">Analyzing your activities…</div>`;
  api(`/api/vo2max/analysis?period=${period}`)
    .then(renderVo2Analysis)
    .catch((ex) => {
      document.getElementById("vo2-analysis-body").innerHTML =
        `<div class="empty">Could not analyze: ${ex.message}</div>`;
    });
}

function renderVo2Analysis(data) {
  const body = document.getElementById("vo2-analysis-body");
  const acts = data.activities || [];

  if (!acts.length) {
    body.innerHTML = `<div class="empty">No VO₂ max increases found in this period. Keep training — outdoor runs with GPS &amp; heart rate produce VO₂ max estimates.</div>`;
    return;
  }

  const rows = acts
    .map((a) => {
      const date = a.startTime
        ? new Date(a.startTime.replace(" ", "T")).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";
      return `
      <div class="vo2a-row clickable" data-id="${a.activityId}">
        <div class="vo2a-icon">${sportIcon(a.type)}</div>
        <div>
          <div class="vo2a-name">${a.name || prettyLabel(a.type) || "Run"}</div>
          <div class="vo2a-date">${date} · ${a.distanceKm ?? "–"} km · ${fmtPace(a.paceMinPerKm)}</div>
        </div>
        <div class="vo2a-jump">
          <span class="vo2a-from">${a.vo2From}</span>
          <span class="vo2a-arrow">→</span>
          <span class="vo2a-to">${a.vo2To}</span>
          <span class="vo2a-delta">▲ ${a.delta}</span>
        </div>
      </div>`;
    })
    .join("");

  body.innerHTML = `
    <div class="vo2a-summary">
      <strong>${data.count}</strong> activit${data.count === 1 ? "y" : "ies"} raised your VO₂ max
      by a total of <strong class="vo2a-gain">+${data.totalGain}</strong> in this period.
    </div>
    <div class="vo2a-list">${rows}</div>
  `;

  body.querySelectorAll(".vo2a-row.clickable").forEach((el) => {
    el.addEventListener("click", () => {
      closeVo2Analysis();
      openActivityModal(el.dataset.id);
    });
  });
}

document.getElementById("vo2-analysis-close").addEventListener("click", closeVo2Analysis);
document.getElementById("vo2-analysis-modal").addEventListener("click", (e) => {
  if (e.target.id === "vo2-analysis-modal") closeVo2Analysis();
});
document.querySelectorAll("#vo2-analysis-periods button").forEach((b) => {
  b.addEventListener("click", () => loadVo2Analysis(b.dataset.period));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeVo2Analysis();
});

// -------------------------------------------------------- activity modal

function paceFromSpeed(mps) {
  if (!mps || mps <= 0) return null;
  return 1000 / mps / 60; // minutes per km
}

function speedKmh(mps) {
  if (!mps || mps <= 0) return null;
  return mps * 3.6;
}

function prettyLabel(raw) {
  // "IMPACTING_TEMPO_22" -> "Impacting Tempo"
  if (!raw) return null;
  return String(raw)
    .replace(/_\d+$/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmt(v, digits = 0, suffix = "") {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const n = Number(v);
  const rounded = digits ? n.toFixed(digits) : Math.round(n).toLocaleString();
  return `${rounded}${suffix}`;
}

function openActivityModal(activityId) {
  const modal = document.getElementById("activity-modal");
  modal.classList.remove("hidden");
  document.getElementById("activity-modal-body").innerHTML =
    `<div class="empty">Loading activity details…</div>`;
  document.querySelector("#activity-modal .modal-head h2").textContent = "Activity details";

  api(`/api/activities/${activityId}`)
    .then(renderActivityDetail)
    .catch((ex) => {
      document.getElementById("activity-modal-body").innerHTML =
        `<div class="empty">Could not load details: ${ex.message}</div>`;
    });
}

function closeActivityModal() {
  document.getElementById("activity-modal").classList.add("hidden");
  if (lapsChart) {
    lapsChart.destroy();
    lapsChart = null;
  }
}

const DETAIL_SECTION_ICONS = {
  "Pace & Speed": "🏃",
  "Heart Rate": "❤",
  "Running Dynamics": "🦿",
  Power: "⚡",
  Elevation: "⛰",
  "Training Effect": "🎯",
  Other: "📋",
  Laps: "🔄",
};

function section(title, rows) {
  const visible = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "–");
  if (!visible.length) return "";
  const icon = DETAIL_SECTION_ICONS[title] || "•";
  const hasMore = visible.length > 2;
  return `
    <div class="detail-section">
      <h3><span class="detail-section-icon" aria-hidden="true">${icon}</span>${title}</h3>
      <div class="detail-grid">
        ${visible
          .map(
            (r, index) => `
          <div class="detail-item${index >= 2 ? " detail-extra" : ""}">
            <div class="d-val">${r.value}</div>
            <div class="d-lab">${r.label}</div>
          </div>`
          )
          .join("")}
      </div>${
        hasMore
          ? `<button class="detail-more" type="button" aria-expanded="false">Show more</button>`
          : ""
      }
    </div>`;
}

const MUSCLE_GROUP_RULES = [
  { id: "chest", label: "Chest", terms: ["bench", "chest", "push up", "pushup", "fly"] },
  { id: "shoulders", label: "Shoulders", terms: ["shoulder", "overhead", "military press", "lateral raise"] },
  { id: "back", label: "Back", terms: ["row", "lat", "pulldown", "pull down", "back", "deadlift"] },
  { id: "arms", label: "Arms", terms: ["curl", "biceps", "triceps", "extension"] },
  { id: "core", label: "Core", terms: ["abs", "abdominal", "plank", "crunch", "core"] },
  { id: "glutes", label: "Glutes", terms: ["glute", "hip thrust", "bridge", "deadlift"] },
  { id: "quads", label: "Quads", terms: ["squat", "leg press", "lunge", "quad", "extension"] },
  { id: "hamstrings", label: "Hamstrings", terms: ["hamstring", "leg curl", "deadlift"] },
  { id: "calves", label: "Calves", terms: ["calf", "calves"] },
];

function renderMuscleFocus(d) {
  const exercises = Array.isArray(d.exercises) ? d.exercises : [];
  if (!(d.type || "").includes("strength") && !exercises.length) return "";
  if (!exercises.length) {
    return `<div class="muscle-focus detail-section">
      <h3><span class="detail-section-icon" aria-hidden="true">🏋️</span>Muscle focus</h3>
      <p class="muscle-empty">Garmin did not provide exercise-level muscle data for this workout.</p>
    </div>`;
  }

  const names = exercises.map((exercise) =>
    String(exercise.name || "").toLowerCase().replace(/[_-]+/g, " ")
  );
  const groups = MUSCLE_GROUP_RULES.filter((group) =>
    names.some((name) => group.terms.some((term) => name.includes(term)))
  );
  const activeIds = new Set(groups.map((group) => group.id));
  const exerciseList = exercises
    .slice(0, 6)
    .map((exercise) => `<span class="exercise-chip">${prettyLabel(exercise.name) || exercise.name}</span>`)
    .join("");
  const muscleClass = (id) => `muscle-zone ${id}${activeIds.has(id) ? " active" : ""}`;
  const groupList = groups.length
    ? groups.map((group) => `<span class="muscle-chip">${group.label}</span>`).join("")
    : `<span class="muscle-muted">Muscle group not identified</span>`;

  return `<div class="muscle-focus detail-section">
    <h3><span class="detail-section-icon" aria-hidden="true">🏋️</span>Muscle focus</h3>
    <div class="muscle-focus-layout">
      <div class="body-map" role="img" aria-label="Highlighted muscle groups: ${groups.map((group) => group.label).join(", ") || "not identified"}">
        <svg viewBox="0 0 220 360" aria-hidden="true" focusable="false">
          <circle class="body-base head" cx="110" cy="25" r="18" />
          <path class="body-base neck" d="M99 41c3-3 7-4 11-4s8 1 11 4v22H99z" />
          <path class="body-base torso" d="M79 61c8-8 18-12 31-12s23 4 31 12l13 75c-7 12-22 19-44 19s-37-7-44-19z" />
          <path class="body-base arm" d="M80 63c-8 1-13 7-17 17l-18 65c-2 8 2 14 9 16 7 1 12-3 14-10l23-64z" />
          <path class="body-base arm" d="M140 63c8 1 13 7 17 17l18 65c2 8-2 14-9 16-7 1-12-3-14-10l-23-64z" />
          <path class="body-base pelvis" d="M84 135c8 6 17 9 26 9s18-3 26-9l6 39c-8 9-18 14-32 14s-24-5-32-14z" />
          <path class="body-base thigh" d="M84 168c8 5 17 7 26 7l-3 82c-4 10-11 14-20 10l-11-77z" />
          <path class="body-base thigh" d="M136 168c-8 5-17 7-26 7l3 82c4 10 11 14 20 10l11-77z" />
          <path class="body-base calf" d="M87 250c7 2 14 1 20-3l-4 103c-2 9-8 13-16 10l-9-94z" />
          <path class="body-base calf" d="M133 250c-7 2-14 1-20-3l4 103c2 9 8 13 16 10l9-94z" />
          <path class="body-base foot" d="M87 348c6 2 11 1 16 0l-2 10c-7 5-16 5-24 1 1-5 4-9 10-11z" />
          <path class="body-base foot" d="M133 348c-6 2-11 1-16 0l2 10c7 5 16 5 24 1-1-5-4-9-10-11z" />
          <path class="${muscleClass("shoulders")}" d="M78 59c7-9 18-13 32-13v25c-12 4-23 2-33-4zM142 59c-7-9-18-13-32-13v25c12 4 23 2 33-4z" />
          <path class="${muscleClass("back")}" d="M88 72c7-5 15-7 22-7s15 2 22 7l-4 35c-6 5-12 7-18 7s-12-2-18-7z" />
          <path class="${muscleClass("chest")}" d="M82 78c8-7 18-9 28-5v25c-10 3-20 1-28-5zM138 78c-8-7-18-9-28-5v25c10 3 20 1 28-5z" />
          <path class="${muscleClass("arms")}" d="M75 78l-22 62c-2 5 1 9 6 10l8-4 22-57zM145 78l22 62c2 5-1 9-6 10l-8-4-22-57z" />
          <path class="${muscleClass("core")}" d="M92 103h36l3 38c-7 7-14 10-21 10s-14-3-21-10z" />
          <path class="${muscleClass("glutes")}" d="M84 137c8 4 17 6 26 6s18-2 26-6l-3 30c-8 7-16 10-23 10s-15-3-23-10z" />
          <path class="${muscleClass("quads")}" d="M84 164c8 5 17 7 26 7l-3 63-18 1zM136 164c-8 5-17 7-26 7l3 63 18 1z" />
          <path class="${muscleClass("hamstrings")}" d="M89 228l18-1-5 104c-4 6-9 7-14 3zM131 228l-18-1 5 104c4 6 9 7 14 3z" />
          <path class="${muscleClass("calves")}" d="M88 327l14 1-4 20c-2 7-8 8-13 5zM132 327l-14 1 4 20c2 7 8 8 13 5z" />
        </svg>
      </div>
      <div class="muscle-focus-info">
        <div class="muscle-chips">${groupList}</div>
        <div class="exercise-list">${exerciseList}</div>
      </div>
    </div>
  </div>`;
}

function renderActivityDetail(d) {
  const s = d.summary || {};
  const isFoot = ["running", "walking", "hiking"].some((t) => (d.type || "").includes(t));
  const avgPace = paceFromSpeed(s.averageSpeed);
  const maxPace = paceFromSpeed(s.maxSpeed);

  const title = d.name || prettyLabel(d.type) || "Activity";
  document.querySelector("#activity-modal .modal-head h2").textContent =
    `${sportIcon(d.type)} ${title}`;

  const start = s.startTimeLocal
    ? new Date(s.startTimeLocal.replace(" ", "T")).toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  // Hero metrics
  const hero = [
    { value: `${fmt(s.distance / 1000, 2)} km`, label: "Distance" },
    { value: fmtDuration(s.duration), label: "Time" },
    isFoot
      ? { value: avgPace ? fmtPace(avgPace) : "–", label: "Avg pace" }
      : { value: speedKmh(s.averageSpeed) ? `${fmt(speedKmh(s.averageSpeed), 1)} km/h` : "–", label: "Avg speed" },
    { value: fmt(s.calories, 0, " kcal"), label: "Calories" },
  ];

  const meta = [
    start,
    d.location,
    d.manufacturer ? prettyLabel(d.manufacturer) : null,
    d.personalRecord ? "🏆 Personal record" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = `
    <div class="detail-meta">${meta}</div>
    <div class="detail-actions">
      <span id="run-type-badge" class="run-badge"></span>
      <button class="btn-compare" data-id="${d.activityId}">
        📊 Compare with a previous activity
      </button>
    </div>
    <div class="hero-stats">
      ${hero
        .map(
          (h) => `<div class="hero-stat"><div class="h-val">${h.value}</div><div class="h-lab">${h.label}</div></div>`
        )
        .join("")}
    </div>

    ${renderMuscleFocus(d)}

    <div class="activity-detail-sections">
    ${section("Pace & Speed", [
      { label: "Avg pace", value: avgPace ? fmtPace(avgPace) : null },
      { label: "Best pace", value: maxPace ? fmtPace(maxPace) : null },
      { label: "Avg speed", value: speedKmh(s.averageSpeed) ? `${fmt(speedKmh(s.averageSpeed), 1)} km/h` : null },
      { label: "Max speed", value: speedKmh(s.maxSpeed) ? `${fmt(speedKmh(s.maxSpeed), 1)} km/h` : null },
      { label: "Moving time", value: s.movingDuration ? fmtDuration(s.movingDuration) : null },
      { label: "Elapsed time", value: s.elapsedDuration ? fmtDuration(s.elapsedDuration) : null },
    ])}

    ${section("Heart Rate", [
      { label: "Avg HR", value: s.averageHR ? fmt(s.averageHR, 0, " bpm") : null },
      { label: "Max HR", value: s.maxHR ? fmt(s.maxHR, 0, " bpm") : null },
      { label: "Min HR", value: s.minHR ? fmt(s.minHR, 0, " bpm") : null },
      { label: "Recovery HR", value: s.recoveryHeartRate ? fmt(s.recoveryHeartRate, 0, " bpm") : null },
    ])}

    ${section("Running Dynamics", [
      { label: "Avg cadence", value: s.averageRunCadence ? fmt(s.averageRunCadence, 0, " spm") : null },
      { label: "Max cadence", value: s.maxRunCadence ? fmt(s.maxRunCadence, 0, " spm") : null },
      { label: "Stride length", value: s.strideLength ? fmt(s.strideLength, 0, " cm") : null },
      { label: "Ground contact", value: s.groundContactTime ? fmt(s.groundContactTime, 0, " ms") : null },
      { label: "Vert. oscillation", value: s.verticalOscillation ? fmt(s.verticalOscillation, 1, " cm") : null },
      { label: "Vert. ratio", value: s.verticalRatio ? fmt(s.verticalRatio, 1, " %") : null },
      { label: "Steps", value: s.steps ? fmt(s.steps) : null },
    ])}

    ${section("Power", [
      { label: "Avg power", value: s.averagePower ? fmt(s.averagePower, 0, " W") : null },
      { label: "Max power", value: s.maxPower ? fmt(s.maxPower, 0, " W") : null },
      { label: "Normalized power", value: s.normalizedPower ? fmt(s.normalizedPower, 0, " W") : null },
    ])}

    ${section("Elevation", [
      { label: "Elev. gain", value: s.elevationGain != null ? fmt(s.elevationGain, 0, " m") : null },
      { label: "Elev. loss", value: s.elevationLoss != null ? fmt(s.elevationLoss, 0, " m") : null },
      { label: "Max elevation", value: s.maxElevation != null ? fmt(s.maxElevation, 0, " m") : null },
      { label: "Min elevation", value: s.minElevation != null ? fmt(s.minElevation, 0, " m") : null },
    ])}

    ${section("Training Effect", [
      { label: "Aerobic TE", value: s.trainingEffect ? fmt(s.trainingEffect, 1) : null },
      { label: "Anaerobic TE", value: s.anaerobicTrainingEffect ? fmt(s.anaerobicTrainingEffect, 1) : null },
      { label: "Focus", value: prettyLabel(s.trainingEffectLabel) },
      { label: "Aerobic effect", value: prettyLabel(s.aerobicTrainingEffectMessage) },
      { label: "Training load", value: s.activityTrainingLoad ? fmt(s.activityTrainingLoad, 0) : null },
      { label: "Vigorous min", value: s.vigorousIntensityMinutes ? fmt(s.vigorousIntensityMinutes) : null },
      { label: "Moderate min", value: s.moderateIntensityMinutes ? fmt(s.moderateIntensityMinutes) : null },
    ])}

    ${section("Other", [
      { label: "Total calories", value: s.calories ? fmt(s.calories, 0, " kcal") : null },
      { label: "Resting (BMR)", value: s.bmrCalories ? fmt(s.bmrCalories, 0, " kcal") : null },
      { label: "Sweat loss", value: s.waterEstimated ? fmt(s.waterEstimated, 0, " ml") : null },
      { label: "Body battery", value: s.differenceBodyBattery != null ? fmt(s.differenceBodyBattery) : null },
      { label: "Laps", value: d.lapCount ? fmt(d.lapCount) : null },
    ])}

    <div id="laps-container" class="detail-section">
      <h3>Laps</h3>
      <div class="empty">Loading laps…</div>
    </div>
    </div>
  `;

  document.getElementById("activity-modal-body").innerHTML = body;

  document.querySelectorAll("#activity-modal .detail-more").forEach((button) => {
    button.addEventListener("click", () => {
      const details = button.closest(".detail-section");
      const expanded = details.classList.toggle("expanded");
      button.textContent = expanded ? "Show less" : "Show more";
      button.setAttribute("aria-expanded", String(expanded));
    });
  });

  const cmpBtn = document.querySelector("#activity-modal .btn-compare");
  if (cmpBtn) {
    cmpBtn.addEventListener("click", () => openCompareModal(cmpBtn.dataset.id));
  }

  loadActivityLaps(d.activityId, isFoot);
}

function loadActivityLaps(activityId, isFoot) {
  api(`/api/activities/${activityId}/laps`)
    .then((data) => renderLaps(data, isFoot))
    .catch(() => {
      const c = document.getElementById("laps-container");
      if (c) c.innerHTML = `<h3>Laps</h3><div class="empty">Lap data unavailable.</div>`;
    });
}

const PHASE_CLASS = {
  "Warm up": "phase-warmup",
  "Cool down": "phase-cooldown",
  Recovery: "phase-recovery",
  Rest: "phase-rest",
  Run: "phase-run",
  Active: "phase-run",
  Interval: "phase-run",
};

function renderLaps(data, isFoot) {
  const laps = (data && data.laps) || [];
  const isInterval = !!(data && data.isInterval);
  const c = document.getElementById("laps-container");
  if (!c) return;

  // Update the run-type badge shown near the top of the detail modal.
  const badge = document.getElementById("run-type-badge");
  if (badge) {
    badge.textContent = isInterval ? "⚡ Interval workout" : "🏃 Free run (laps)";
    badge.className = `run-badge ${isInterval ? "interval" : ""}`;
  }

  if (!laps.length) {
    c.innerHTML = `<h3>Laps</h3><div class="empty">No lap data for this activity.</div>`;
    return;
  }

  lapState = { laps, isInterval, isFoot };

  // Distinct phases present (for the interval filter).
  const phases = [...new Set(laps.map((l) => l.phase).filter(Boolean))];
  const showFilter = isInterval && phases.length > 1;
  const title = isInterval ? `Intervals (${laps.length})` : `Laps (${laps.length})`;

  const pacing = isFoot
    ? repConsistencyHtml(laps, isInterval) + negativeSplitHtml(laps, isInterval)
    : "";

  c.innerHTML = `
    ${pacing}
    <div class="laps-head">
      <h3>${title}</h3>
      ${
        showFilter
          ? `<select id="lap-filter" class="lap-filter">
               <option value="all">All phases</option>
               ${phases.map((p) => `<option value="${p}">${p} only</option>`).join("")}
             </select>`
          : ""
      }
    </div>
    <div id="laps-body"></div>
  `;

  if (showFilter) {
    document
      .getElementById("lap-filter")
      .addEventListener("change", (e) => renderLapsBody(e.target.value));
  }
  renderLapsBody("all");
}

// Interval rep consistency: fade % and spread across the work reps.
function repConsistencyHtml(laps, isInterval) {
  if (!isInterval) return "";
  const reps = laps.filter((l) => l.phase === "Interval" && l.paceMinPerKm);
  if (reps.length < 3) return "";
  const paces = reps.map((l) => l.paceMinPerKm);
  const avg = paces.reduce((a, b) => a + b, 0) / paces.length;
  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);
  const k = Math.max(1, Math.ceil(reps.length / 3));
  const firstAvg = paces.slice(0, k).reduce((a, b) => a + b, 0) / k;
  const lastAvg = paces.slice(-k).reduce((a, b) => a + b, 0) / k;
  const fade = ((lastAvg - firstAvg) / firstAvg) * 100;
  let cls, label;
  if (fade > 3) {
    cls = "watch";
    label = `Faded ${fade.toFixed(0)}% — reps slowed later`;
  } else if (fade < -1) {
    cls = "good";
    label = "Strong finish — reps got faster";
  } else {
    cls = "good";
    label = "Consistent reps 👍";
  }
  return `
    <div class="pacing-block ${cls}">
      <div class="pacing-title">${reps.length} work reps · ${label}</div>
      <div class="pacing-detail">avg ${fmtPace(avg)} · fastest ${fmtPace(fastest)} · slowest ${fmtPace(slowest)}</div>
    </div>`;
}

// Negative-split analysis: first half vs second half pace by time.
// For interval workouts, only the work (Interval) laps count — recovery jogs
// would otherwise dominate and make the split meaningless.
function negativeSplitHtml(laps, isInterval) {
  const src = isInterval ? laps.filter((l) => l.phase === "Interval") : laps;
  const valid = src.filter((l) => l.durationSec && l.distanceKm && l.averageSpeed);
  if (valid.length < 2) return "";
  const total = valid.reduce((t, l) => t + l.durationSec, 0);
  let cum = 0;
  const first = [];
  const second = [];
  for (const l of valid) {
    (cum < total / 2 ? first : second).push(l);
    cum += l.durationSec;
  }
  const halfPace = (arr) => {
    const dkm = arr.reduce((t, l) => t + (l.distanceKm || 0), 0);
    const tsec = arr.reduce((t, l) => t + (l.durationSec || 0), 0);
    return dkm > 0 ? tsec / 60 / dkm : null;
  };
  const p1 = halfPace(first);
  const p2 = halfPace(second);
  if (!p1 || !p2) return "";
  const diff = p2 - p1; // negative = faster 2nd half
  const secPerKm = Math.round(diff * 60);
  let cls, label;
  if (diff < -0.03) {
    cls = "good";
    label = "Negative split 👍 (finished faster)";
  } else if (diff > 0.08) {
    cls = "watch";
    label = "Positive split (faded in 2nd half)";
  } else {
    cls = "ok";
    label = "Even split";
  }
  return `
    <div class="pacing-block ${cls}">
      <div class="pacing-title">${isInterval ? "Interval pacing" : "Pacing"} · ${label}</div>
      <div class="pacing-detail">1st half ${fmtPace(p1)} → 2nd half ${fmtPace(p2)} (${secPerKm >= 0 ? "+" : ""}${secPerKm}s/km)</div>
    </div>`;
}

function renderLapsBody(filter) {
  if (!lapState) return;
  const { isInterval, isFoot } = lapState;
  let laps = lapState.laps;
  if (filter && filter !== "all") {
    laps = laps.filter((l) => l.phase === filter);
  }
  const body = document.getElementById("laps-body");
  if (!body) return;
  if (!laps.length) {
    body.innerHTML = `<div class="empty">No laps for this phase.</div>`;
    return;
  }

  // Summary of the filtered set — handy for comparing e.g. all 400 m reps.
  let summary = "";
  if (filter && filter !== "all") {
    const totalDist = laps.reduce((t, l) => t + (l.distanceKm || 0), 0);
    const totalTime = laps.reduce((t, l) => t + (l.durationSec || 0), 0);
    const avgPace = totalDist > 0 ? totalTime / 60 / totalDist : null;
    const hrs = laps.map((l) => l.averageHR).filter(Boolean);
    const cads = laps.map((l) => l.averageRunCadence).filter(Boolean);
    const avgHR = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
    const avgCad = cads.length ? Math.round(cads.reduce((a, b) => a + b, 0) / cads.length) : null;
    summary = `
      <div class="lap-filter-summary">
        <b>${laps.length}× ${filter}</b> ·
        avg ${isFoot ? (avgPace ? fmtPace(avgPace) : "–") : `${fmt(speedKmh(totalDist * 1000 / totalTime), 1)} km/h`}
        · avg HR ${avgHR ?? "–"}
        · avg cad ${avgCad ?? "–"}
      </div>`;
  }

  const rows = laps
    .map((l) => {
      const speedTxt = isFoot
        ? l.paceMinPerKm
          ? fmtPace(l.paceMinPerKm)
          : "–"
        : speedKmh(l.averageSpeed)
        ? `${fmt(speedKmh(l.averageSpeed), 1)} km/h`
        : "–";
      const phaseCell = isInterval
        ? `<div><span class="phase-tag ${PHASE_CLASS[l.phase] || ""}">${l.phase || "–"}</span></div>`
        : "";
      return `
      <div class="lap-row${isInterval ? " lap-row-interval" : ""}">
        <div class="lap-idx">${l.lapIndex ?? ""}</div>
        ${phaseCell}
        <div>${l.distanceKm != null ? l.distanceKm.toFixed(2) + " km" : "–"}</div>
        <div>${fmtDuration(l.durationSec)}</div>
        <div>${speedTxt}</div>
        <div>${l.averageHR ? Math.round(l.averageHR) : "–"}</div>
        <div>${l.averageRunCadence ? Math.round(l.averageRunCadence) : "–"}</div>
        ${isInterval ? "" : `<div>${l.elevationGain != null ? Math.round(l.elevationGain) + " m" : "–"}</div>`}
      </div>`;
    })
    .join("");

  const head = isInterval
    ? `<div class="lap-row lap-row-interval lap-head">
        <div class="lap-idx">#</div>
        <div>Phase</div>
        <div>Dist</div>
        <div>Time</div>
        <div>${isFoot ? "Pace" : "Speed"}</div>
        <div>HR</div>
        <div>Cad</div>
      </div>`
    : `<div class="lap-row lap-head">
        <div class="lap-idx">#</div>
        <div>Dist</div>
        <div>Time</div>
        <div>${isFoot ? "Pace" : "Speed"}</div>
        <div>HR</div>
        <div>Cad</div>
        <div>Elev</div>
      </div>`;

  body.innerHTML = `
    ${summary}
    <div class="lap-table">
      ${head}
      ${rows}
    </div>
    <canvas id="laps-chart" height="170"></canvas>
  `;

  renderLapsChart(laps, isFoot);
}

function renderLapsChart(laps, isFoot) {
  const canvas = document.getElementById("laps-chart");
  if (!canvas) return;

  const labels = laps.map((l) => `L${l.lapIndex ?? ""}`);
  const paceVals = laps.map((l) =>
    isFoot ? l.paceMinPerKm : speedKmh(l.averageSpeed)
  );
  const hrVals = laps.map((l) => l.averageHR || null);
  const primaryLabel = isFoot ? "Pace (min/km)" : "Speed (km/h)";

  const phaseColors = {
    "Warm up": "#fbbf24",
    "Cool down": "#38bdf8",
    Recovery: "#a78bfa",
    Rest: "#64748b",
    Run: "#2dd4bf",
    Active: "#2dd4bf",
    Interval: "#2dd4bf",
  };
  const hasPhases = laps.some((l) => l.phase && l.phase !== "Run");
  const barColors = hasPhases
    ? laps.map((l) => phaseColors[l.phase] || "#2dd4bf")
    : "#2dd4bf";

  if (lapsChart) lapsChart.destroy();
  lapsChart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: primaryLabel,
          data: paceVals,
          backgroundColor: barColors,
          borderRadius: 5,
          yAxisID: "y",
          order: 2,
        },
        {
          type: "line",
          label: "Avg HR (bpm)",
          data: hrVals,
          borderColor: "#f87171",
          backgroundColor: "#f87171",
          tension: 0.3,
          pointRadius: 3,
          yAxisID: "y1",
          order: 1,
        },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e8eef9" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.type === "bar" && isFoot) {
                return `Pace: ${fmtPace(ctx.parsed.y)}`;
              }
              return `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#9fb0cc" }, grid: { display: false } },
        y: {
          position: "left",
          reverse: isFoot, // faster (lower pace) shown higher
          ticks: { color: "#2dd4bf" },
          grid: { color: "#243450" },
          title: { display: true, text: primaryLabel, color: "#9fb0cc" },
        },
        y1: {
          position: "right",
          ticks: { color: "#f87171" },
          grid: { drawOnChartArea: false },
          title: { display: true, text: "HR", color: "#9fb0cc" },
        },
      },
    },
  });
}

document.getElementById("activity-close").addEventListener("click", closeActivityModal);
document.getElementById("activity-modal").addEventListener("click", (e) => {
  if (e.target.id === "activity-modal") closeActivityModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeActivityModal();
});

// -------------------------------------------------------- compare modal

let compareChart = null;
let lapCompareChart = null;

function openCompareModal(activityId) {
  const modal = document.getElementById("compare-modal");
  modal.classList.remove("hidden");
  document.getElementById("compare-modal-body").innerHTML =
    `<div class="empty">Finding a comparable previous activity…</div>`;

  api(`/api/activities/${activityId}/compare`)
    .then(renderComparison)
    .catch((ex) => {
      document.getElementById("compare-modal-body").innerHTML =
        `<div class="empty">Could not compare: ${ex.message}</div>`;
    });
}

function closeCompareModal() {
  document.getElementById("compare-modal").classList.add("hidden");
  if (compareChart) {
    compareChart.destroy();
    compareChart = null;
  }
  if (lapCompareChart) {
    lapCompareChart.destroy();
    lapCompareChart = null;
  }
}

function shortDate(t) {
  if (!t) return "";
  return new Date(t.replace(" ", "T")).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Build one comparison row. `lowerIsBetter` decides which direction is green.
function compareRow(label, cur, prev, format, lowerIsBetter = true, unit = "") {
  if (cur == null || prev == null) return "";
  const diff = cur - prev;
  let cls = "neutral";
  let arrow = "";
  if (Math.abs(diff) > 1e-9) {
    const improved = lowerIsBetter ? diff < 0 : diff > 0;
    cls = improved ? "better" : "worse";
    arrow = improved ? "▼" : "▲";
    if (!lowerIsBetter) arrow = diff > 0 ? "▲" : "▼";
  }
  const pct = prev ? Math.abs((diff / prev) * 100) : 0;
  const diffText =
    Math.abs(diff) < 1e-9
      ? "same"
      : `${arrow} ${format(Math.abs(diff))}${unit} (${pct.toFixed(1)}%)`;
  return `
    <div class="cmp-row">
      <div class="cmp-label">${label}</div>
      <div class="cmp-cur">${format(cur)}${unit}</div>
      <div class="cmp-prev">${format(prev)}${unit}</div>
      <div class="cmp-delta ${cls}">${diffText}</div>
    </div>`;
}

function renderComparison(data) {
  const body = document.getElementById("compare-modal-body");
  const cur = data.current;
  const prev = data.previous;

  if (!prev) {
    body.innerHTML = `<div class="empty">${data.message || "No comparable activity found."}</div>`;
    return;
  }

  const idPace = (v) => fmtPace(v);
  const idTime = (v) => fmtDuration(v);
  const idNum = (v) => Math.round(v).toLocaleString();
  const idKm = (v) => Number(v).toFixed(2);

  body.innerHTML = `
    ${data.matchNote ? `<div class="cmp-match">🎯 ${data.matchNote}</div>` : ""}
    <div class="cmp-heads">
      <div class="cmp-head current">
        <div class="cmp-tag">This activity</div>
        <div class="cmp-name">${cur.name || prettyLabel(cur.type) || "Activity"}</div>
        <div class="cmp-sub">${shortDate(cur.startTime)} · ${idKm(cur.distanceKm)} km</div>
      </div>
      <div class="cmp-vs">vs</div>
      <div class="cmp-head previous">
        <div class="cmp-tag">Previous</div>
        <div class="cmp-name">${prev.name || prettyLabel(prev.type) || "Activity"}</div>
        <div class="cmp-sub">${shortDate(prev.startTime)} · ${idKm(prev.distanceKm)} km</div>
      </div>
    </div>

    <div class="cmp-table">
      <div class="cmp-row cmp-header">
        <div class="cmp-label">Metric</div>
        <div class="cmp-cur">This</div>
        <div class="cmp-prev">Previous</div>
        <div class="cmp-delta">Change</div>
      </div>
      ${compareRow("Distance", cur.distanceKm, prev.distanceKm, idKm, false, " km")}
      ${compareRow("Total time", cur.durationSec, prev.durationSec, idTime, true)}
      ${compareRow("Avg pace", cur.paceMinPerKm, prev.paceMinPerKm, idPace, true)}
      ${compareRow("Avg HR", cur.averageHR, prev.averageHR, idNum, true, " bpm")}
      ${compareRow("Max HR", cur.maxHR, prev.maxHR, idNum, true, " bpm")}
      ${compareRow("Calories", cur.calories, prev.calories, idNum, false, " kcal")}
    </div>

    <div class="cmp-note">
      Bars show this activity relative to the previous one (previous = 100%).
      Shorter bars on time &amp; pace mean you were faster. ▼ green = improvement.
    </div>
    <canvas id="compare-chart" height="170"></canvas>

    <div id="lap-compare" class="cmp-lap-section">
      <h3>Lap-by-lap comparison</h3>
      <div class="empty">Loading lap comparison…</div>
    </div>
  `;

  renderCompareChart(cur, prev);

  const isFoot = ["running", "walking", "hiking"].some((t) =>
    (cur.type || "").includes(t)
  );
  loadLapCompare(cur.activityId, prev.activityId, isFoot);
}

function renderCompareChart(cur, prev) {
  const canvas = document.getElementById("compare-chart");
  if (!canvas) return;

  const rel = (c, p) => (p ? (c / p) * 100 : null);
  const labels = ["Time", "Pace", "Avg HR"];
  const currentRel = [
    rel(cur.durationSec, prev.durationSec),
    rel(cur.paceMinPerKm, prev.paceMinPerKm),
    rel(cur.averageHR, prev.averageHR),
  ];
  const previousRel = labels.map(() => 100);

  if (compareChart) compareChart.destroy();
  compareChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "This activity",
          data: currentRel,
          backgroundColor: "#2dd4bf",
          borderRadius: 6,
        },
        {
          label: "Previous",
          data: previousRel,
          backgroundColor: "#64748b",
          borderRadius: 6,
        },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e8eef9" } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { ticks: { color: "#9fb0cc" }, grid: { display: false } },
        y: {
          ticks: { color: "#9fb0cc", callback: (v) => `${v}%` },
          grid: { color: "#243450" },
          suggestedMin: 0,
        },
      },
    },
  });
}

function loadLapCompare(curId, prevId, isFoot) {
  Promise.all([
    api(`/api/activities/${curId}/laps`).then((d) => d.laps || []).catch(() => []),
    api(`/api/activities/${prevId}/laps`).then((d) => d.laps || []).catch(() => []),
  ]).then(([curLaps, prevLaps]) => {
    // For structured interval workouts, compare only the work intervals and
    // skip warm-up / cool-down / recovery / rest laps.
    const structured = isStructuredLaps(curLaps) || isStructuredLaps(prevLaps);
    if (structured) {
      curLaps = workLaps(curLaps);
      prevLaps = workLaps(prevLaps);
    }
    renderLapCompare(curLaps, prevLaps, isFoot, structured);
  });
}

function isStructuredLaps(laps) {
  return laps.some((l) =>
    ["Warm up", "Cool down", "Recovery", "Rest"].includes(l.phase)
  );
}

function workLaps(laps) {
  return laps.filter((l) => l.phase === "Run" || l.phase === "Active");
}

function renderLapCompare(curLaps, prevLaps, isFoot, structured) {
  const c = document.getElementById("lap-compare");
  if (!c) return;
  if (!curLaps.length && !prevLaps.length) {
    c.innerHTML = `<h3>Lap-by-lap comparison</h3><div class="empty">No lap data to compare.</div>`;
    return;
  }

  const paceOrSpeed = (l) =>
    isFoot ? l.paceMinPerKm : speedKmh(l.averageSpeed);
  const fmtPS = (v) =>
    v == null ? "–" : isFoot ? fmtPace(v) : `${fmt(v, 1)} km/h`;

  const n = Math.max(curLaps.length, prevLaps.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const cu = curLaps[i];
    const pr = prevLaps[i];
    const cuP = cu ? paceOrSpeed(cu) : null;
    const prP = pr ? paceOrSpeed(pr) : null;

    let deltaHtml = '<div class="cmp-delta neutral">–</div>';
    if (cuP != null && prP != null) {
      const diff = cuP - prP;
      // For pace lower is better; for speed higher is better.
      const improved = isFoot ? diff < 0 : diff > 0;
      const same = Math.abs(diff) < 1e-9;
      const cls = same ? "neutral" : improved ? "better" : "worse";
      const arrow = same ? "" : improved ? "▲" : "▼";
      const dtxt = isFoot
        ? fmtPace(Math.abs(diff))
        : `${fmt(Math.abs(diff), 1)} km/h`;
      deltaHtml = `<div class="cmp-delta ${cls}">${same ? "same" : `${arrow} ${dtxt}`}</div>`;
    }

    rows.push(`
      <div class="lapc-row">
        <div class="lap-idx">${i + 1}</div>
        <div>${fmtPS(cuP)}</div>
        <div>${fmtPS(prP)}</div>
        ${deltaHtml}
        <div>${cu && cu.averageHR ? Math.round(cu.averageHR) : "–"}</div>
        <div>${pr && pr.averageHR ? Math.round(pr.averageHR) : "–"}</div>
      </div>`);
  }

  c.innerHTML = `
    <h3>Lap-by-lap comparison${
      structured ? ' <span class="lapc-note">· work intervals only</span>' : ""
    }</h3>
    <div class="lapc-table">
      <div class="lapc-row lapc-head">
        <div class="lap-idx">#</div>
        <div>This ${isFoot ? "pace" : "speed"}</div>
        <div>Prev ${isFoot ? "pace" : "speed"}</div>
        <div>Change</div>
        <div>This HR</div>
        <div>Prev HR</div>
      </div>
      ${rows.join("")}
    </div>
    <canvas id="lapc-chart" height="180"></canvas>
  `;

  renderLapCompareChart(curLaps, prevLaps, isFoot);
}

function renderLapCompareChart(curLaps, prevLaps, isFoot) {
  const canvas = document.getElementById("lapc-chart");
  if (!canvas) return;

  const n = Math.max(curLaps.length, prevLaps.length);
  const labels = Array.from({ length: n }, (_, i) => `L${i + 1}`);
  const val = (l) => (l ? (isFoot ? l.paceMinPerKm : speedKmh(l.averageSpeed)) : null);
  const curData = Array.from({ length: n }, (_, i) => val(curLaps[i]));
  const prevData = Array.from({ length: n }, (_, i) => val(prevLaps[i]));
  const axisLabel = isFoot ? "Pace (min/km)" : "Speed (km/h)";

  if (lapCompareChart) lapCompareChart.destroy();
  lapCompareChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "This activity",
          data: curData,
          borderColor: "#2dd4bf",
          backgroundColor: "#2dd4bf",
          tension: 0.3,
          pointRadius: 3,
          spanGaps: true,
        },
        {
          label: "Previous",
          data: prevData,
          borderColor: "#94a3b8",
          backgroundColor: "#94a3b8",
          borderDash: [6, 4],
          tension: 0.3,
          pointRadius: 3,
          spanGaps: true,
        },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e8eef9" } },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${
                isFoot ? fmtPace(ctx.parsed.y) : `${ctx.parsed.y?.toFixed(1)} km/h`
              }`,
          },
        },
      },
      scales: {
        x: { ticks: { color: "#9fb0cc" }, grid: { display: false } },
        y: {
          reverse: isFoot, // faster laps (lower pace) shown higher
          ticks: { color: "#9fb0cc" },
          grid: { color: "#243450" },
          title: { display: true, text: axisLabel, color: "#9fb0cc" },
        },
      },
    },
  });
}

document.getElementById("compare-close").addEventListener("click", closeCompareModal);
document.getElementById("compare-modal").addEventListener("click", (e) => {
  if (e.target.id === "compare-modal") closeCompareModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCompareModal();
});

// Multi-activity compare controls.
document.getElementById("compare-mode-btn").addEventListener("click", () => {
  setCompareMode(!compareMode);
});
document.getElementById("compare-cancel").addEventListener("click", () => setCompareMode(false));
document.getElementById("compare-run").addEventListener("click", () => {
  if (compareSelection.size >= 2) openMultiCompareModal([...compareSelection]);
});
document.getElementById("multi-compare-close").addEventListener("click", closeMultiCompareModal);
document.getElementById("multi-compare-modal").addEventListener("click", (e) => {
  if (e.target.id === "multi-compare-modal") closeMultiCompareModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMultiCompareModal();
});

// ------------------------------------------------------ analysis screen

function analysisBadge(level) {
  if (!level) return "";
  const label = level === "good" ? "Good" : level === "ok" ? "OK" : "Attention";
  return `<span class="assess ${level}">${label}</span>`;
}

// Collapsible "what this means" explanation to keep sections light.
function infoDetails(text) {
  return `<details class="a-info"><summary>What this means</summary><p>${text}</p></details>`;
}

function formCard(label, m) {
  if (!m || m.value == null) return "";
  return `
    <div class="form-card" title="${m.text}">
      <div class="fc-top">
        <span class="fc-val">${m.value} <span class="fc-unit">${m.unit}</span></span>
        ${analysisBadge(m.level)}
      </div>
      <div class="fc-lab">${label}</div>
    </div>`;
}

function worstLevel(levels) {
  if (levels.includes("watch")) return "watch";
  if (levels.includes("ok")) return "ok";
  if (levels.includes("good")) return "good";
  return null;
}

function renderAnalysis(d, weekly) {
  const c = document.getElementById("analysis-content");
  if (!d.runCount) {
    c.innerHTML = `<div class="empty">No running data with the required metrics in this period.</div>`;
    return;
  }
  const z = d.hrZones, load = d.load, form = d.form, gap = d.gap, dec = d.decoupling;
  const inj = d.injuryRisk;
  const formLvl = worstLevel(Object.values(form).map((m) => m && m.level).filter(Boolean));

  // ---- At-a-glance summary chips ----
  const chips = [
    inj && { icon: "🩹", label: "Injury risk", word: inj.headline.split(" ")[0], level: inj.level },
    load && { icon: "📈", label: "Load", word: load.acwr ?? "–", level: load.verdict.level },
    z && { icon: "❤️", label: "Easy (Z1–2)", word: `${z.lowPct}%`, level: z.verdict.level },
    form && { icon: "🦿", label: "Form", word: formLvl === "good" ? "Good" : formLvl === "ok" ? "OK" : "Check", level: formLvl },
    dec && { icon: "💓", label: "Durability", word: `${dec.value}%`, level: dec.verdict.level },
  ].filter(Boolean);

  const chipStrip = `
    <div class="a-chips">
      ${chips
        .map(
          (ch) => `
        <div class="a-chip ${ch.level}">
          <span class="ac-icon">${ch.icon}</span>
          <div>
            <div class="ac-word">${ch.word}</div>
            <div class="ac-label">${ch.label}</div>
          </div>
        </div>`
        )
        .join("")}
    </div>`;

  const weeklyHtml = weekly
    ? `
    <section class="panel analysis-section">
      <h2>🗓️ This week vs last</h2>
      <div class="a-metrics">
        <div class="a-metric"><div class="am-val">${weekly.thisWeek.km} km</div><div class="am-lab">This week · ${weekly.thisWeek.runs} runs</div></div>
        <div class="a-metric"><div class="am-val">${weekly.lastWeek.km} km</div><div class="am-lab">Last week</div></div>
        <div class="a-metric"><div class="am-val">${weekly.thisWeek.longestKm} km</div><div class="am-lab">Longest run</div></div>
        <div class="a-metric"><div class="am-val">${weekly.thisWeek.easyPct != null ? weekly.thisWeek.easyPct + "%" : "–"}</div><div class="am-lab">Easy (Z1–2)</div></div>
        <div class="a-metric"><div class="am-val">${weekly.thisWeek.quality}</div><div class="am-lab">Quality</div></div>
      </div>
      <div class="a-verdict">${weekly.note}</div>
    </section>`
    : "";

  const injHtml = inj
    ? `
    <section class="panel analysis-section">
      <h2>🩹 Injury risk ${analysisBadge(inj.level)}</h2>
      <div class="a-verdict"><strong>${inj.headline}</strong></div>
      <div class="chip-facts">
        ${(inj.factors || [])
          .map(
            (f) => `
          <div class="chip-fact ${f.level}" title="${f.text}">
            <span class="cf-val">${f.value}</span>
            <span class="cf-lab">${f.label}</span>
          </div>`
          )
          .join("")}
      </div>
      ${infoDetails("Combines the factors most linked to running injuries — sudden load ramps (ACWR), big weekly mileage jumps, and outsized long runs.")}
    </section>`
    : "";

  c.innerHTML = `
    <p class="analysis-intro">Last <strong>${d.period} days</strong> · ${d.runCount} runs</p>
    ${chipStrip}
    ${weeklyHtml}
    ${injHtml}

    <section class="panel analysis-section">
      <h2>❤️ Easy vs hard balance ${analysisBadge(z.verdict.level)}</h2>
      <div class="a-two">
        <div class="a-chart"><canvas id="hr-zone-chart"></canvas></div>
        <div class="a-legend">
          <div class="zrow"><span class="zdot easy"></span>Low · Z1–2<b>${z.lowPct}%</b></div>
          <div class="zrow"><span class="zdot mod"></span>Moderate · Z3<b>${z.moderatePct}%</b></div>
          <div class="zrow"><span class="zdot hard"></span>High · Z4–5<b>${z.highPct}%</b></div>
        </div>
      </div>
      <div class="a-verdict">${z.verdict.text}</div>
      ${infoDetails("The polarized 80/20 model: aim for ~80% easy (Z1–2, below LT1, conversational). Z3 is tempo/'grey zone'; Z4–5 is hard. Z3–5 together are the 20%.")}
    </section>

    <section class="panel analysis-section">
      <h2>📈 Training load ${analysisBadge(load.verdict.level)}</h2>
      <div class="a-metrics">
        <div class="a-metric"><div class="am-val">${load.acwr ?? "–"}</div><div class="am-lab">ACWR ratio</div></div>
        <div class="a-metric"><div class="am-val">${load.acute}</div><div class="am-lab">7-day load</div></div>
        <div class="a-metric"><div class="am-val">${load.chronic}</div><div class="am-lab">Weekly avg (28d)</div></div>
      </div>
      <div class="a-verdict">${load.verdict.text}</div>
      ${infoDetails("ACWR = last 7 days of load ÷ 28-day weekly average. The 0.8–1.3 'sweet spot' builds fitness without ramping too fast.")}
    </section>

    <section class="panel analysis-section">
      <h2>🦿 Running form ${analysisBadge(formLvl)}</h2>
      <div class="form-grid">
        ${formCard("Cadence", form.cadence)}
        ${formCard("Vertical osc.", form.verticalOscillation)}
        ${formCard("Vertical ratio", form.verticalRatio)}
        ${formCard("Ground contact", form.groundContactTime)}
        ${formCard("Stride length", form.strideLength)}
      </div>
      ${infoDetails("Biomechanics affecting efficiency and injury risk. Hover a card for what it means. Quicker cadence (170–180) and less vertical bounce are more efficient.")}
    </section>

    <section class="panel analysis-section">
      <h2>👟 Cadence vs pace</h2>
      <div class="a-chart tall"><canvas id="cadence-pace-chart"></canvas></div>
      ${infoDetails("Each dot is a run (click to open it). Cadence should rise smoothly as you speed up; if it stays flat while pace increases, you may be overstriding.")}
    </section>

    <section class="panel analysis-section">
      <h2>⛰️ Terrain (grade-adjusted pace)</h2>
      <div class="a-verdict">${gap.text}</div>
      ${infoDetails("Recalculates hilly runs to their flat-ground equivalent so you can judge effort fairly regardless of terrain.")}
    </section>

    ${
      dec
        ? `
    <section class="panel analysis-section">
      <h2>💓 Aerobic durability ${analysisBadge(dec.verdict.level)}</h2>
      <div class="a-metrics">
        <div class="a-metric"><div class="am-val">${dec.value}%</div><div class="am-lab">Efficiency drop</div></div>
        <div class="a-metric clickable" data-id="${dec.activityId}"><div class="am-val">${dec.distanceKm} km</div><div class="am-lab">${dec.activityName || "Run"} · ${dec.date ? shortDate(dec.date) : ""}</div></div>
      </div>
      <div class="a-verdict">${dec.verdict.text}</div>
      ${infoDetails("On your longest recent run, how much pace-to-HR efficiency dropped from the first half to the second. Under 5% = strong aerobic durability.")}
    </section>`
        : ""
    }
  `;

  renderHrZoneChart(z);
  renderCadencePaceChart(d.cadenceVsPace || []);
  const decEl = c.querySelector(".a-metric.clickable");
  if (decEl && decEl.dataset.id) {
    decEl.addEventListener("click", () => openActivityModal(decEl.dataset.id));
  }
}

function renderHrZoneChart(z) {
  const canvas = document.getElementById("hr-zone-chart");
  if (!canvas) return;
  if (hrZoneChart) hrZoneChart.destroy();
  hrZoneChart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"],
      datasets: [
        {
          data: z.percent,
          backgroundColor: ["#34d399", "#2dd4bf", "#fbbf24", "#fb923c", "#f87171"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: "#9fb0cc", boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}%` } },
      },
    },
  });
}

function renderCadencePaceChart(points) {
  const canvas = document.getElementById("cadence-pace-chart");
  if (!canvas) return;
  const data = points.map((p) => ({
    x: p.pace,
    y: p.cadence,
    activityId: p.activityId,
    name: p.name,
    date: p.date,
  }));
  if (cadencePaceChart) cadencePaceChart.destroy();
  cadencePaceChart = new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Runs", data, backgroundColor: "#2dd4bf", pointRadius: 5, pointHoverRadius: 7 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const p = data[elements[0].index];
        if (p && p.activityId) openActivityModal(p.activityId);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const p = data[items[0].dataIndex];
              return p ? `${p.name || "Run"} · ${p.date ? shortDate(p.date) : ""}` : "";
            },
            label: (ctx) =>
              `${fmtPace(ctx.parsed.x)} · ${Math.round(ctx.parsed.y)} spm — click for details`,
          },
        },
      },
      scales: {
        x: {
          reverse: true, // faster paces (lower min/km) on the right
          title: { display: true, text: "Pace (min/km) — faster →", color: "#9fb0cc" },
          ticks: { color: "#9fb0cc", callback: (v) => fmtPace(v) },
          grid: { color: "#243450" },
        },
        y: {
          title: { display: true, text: "Cadence (spm)", color: "#9fb0cc" },
          ticks: { color: "#9fb0cc" },
          grid: { color: "#243450" },
        },
      },
    },
  });
}

// ----------------------------------------------------------- bootstrap

(async function init() {
  // Feedback after returning from the Strava OAuth redirect.
  const params = new URLSearchParams(window.location.search);
  const strava = params.get("strava");
  if (strava) {
    const msgs = {
      connected: "✓ Strava connected",
      denied: "Strava connection was cancelled",
      error: "Strava connection failed",
    };
    toast(msgs[strava] || "");
    history.replaceState(null, "", window.location.pathname);
  }

  try {
    const s = await api("/api/session");
    if (s.authenticated) {
      await loadDashboard();
      return;
    }
  } catch (_) {}
  show("login-view");
})();
