// Nutrition log: free-text meal entry, daily macro summary vs. workout burn.
// Relies on globals from app.js: api, toast, escapeAttr.

let nutriDay = null;
let nutriHistoryChart = null;
let nutriHistoryDays = 30;

const NUTRI_ROWS = [
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "fiber", label: "Fiber", unit: "g" },
  { key: "sugar", label: "Sugar", unit: "g", limit: true },
  { key: "sodium", label: "Sodium", unit: "mg", limit: true },
];
const NUTRI_STATUS = {
  low: { label: "Low", cls: "low" },
  in_limit: { label: "In limit", cls: "ok" },
  high: { label: "High", cls: "high" },
};

function nutriLocalDate(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

function nutriFmt(v, unit = "") {
  if (v == null) return "–";
  return `${Math.round(v).toLocaleString()}${unit}`;
}

async function loadNutrition() {
  const dateEl = document.getElementById("nutri-date");
  if (!dateEl.value) dateEl.value = nutriLocalDate();
  dateEl.max = nutriLocalDate();
  document.getElementById("nutri-summary").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    renderNutritionDay(await api(`/api/nutrition/day?date=${encodeURIComponent(dateEl.value)}`));
  } catch (ex) {
    document.getElementById("nutri-summary").innerHTML =
      `<div class="empty">Could not load nutrition: ${escapeAttr(ex.message)}</div>`;
  }
}

function renderNutritionDay(day) {
  nutriDay = day;
  renderNutritionMessages(day);
  renderNutritionSummary(day);
}

function renderNutritionMessages(day) {
  const box = document.getElementById("nutri-messages");
  if (!day.entries.length) {
    box.innerHTML = `<div class="nutri-bot nutri-hint">Tell me what you ate — I'll pick out each food and quantity,
      look up its nutrition and compare the day with your workouts.<br>
      <span class="dim">Try: "i had 2 idli with 1 cup sambar", "1 scoop of iso whey", "4 whole eggs", "rice 200g and dal 1 bowl".</span></div>`;
    return;
  }
  box.innerHTML = day.entries
    .map((e) => {
      const rows = e.items
        .map((i) =>
          i.found
            ? `<tr>
                <td>${escapeAttr(i.name)}<div class="nutri-src">${escapeAttr(i.qty)} ${escapeAttr(i.unit)} · ${nutriFmt(i.grams, " g")} · ${escapeAttr(i.source)}</div></td>
                <td>${nutriFmt(i.kcal)}</td><td>${i.protein}</td><td>${i.carbs}</td><td>${i.fat}</td><td>${i.fiber}</td>
              </tr>`
            : `<tr class="nutri-miss"><td colspan="6">❓ Couldn't find “${escapeAttr(i.input)}” — try a more common name or add grams.</td></tr>`
        )
        .join("");
      return `
        <div class="nutri-user"><span>${escapeAttr(e.text)}</span><small>${escapeAttr(e.time)}</small></div>
        <div class="nutri-bot">
          <table class="nutri-items">
            <thead><tr><th>Item</th><th>kcal</th><th>P</th><th>C</th><th>F</th><th>Fib</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td>Total</td><td>${nutriFmt(e.totals.kcal)}</td><td>${e.totals.protein}</td>
              <td>${e.totals.carbs}</td><td>${e.totals.fat}</td><td>${e.totals.fiber}</td></tr></tfoot>
          </table>
          <button class="nutri-del" data-id="${escapeAttr(e.id)}" title="Delete this entry">🗑 Remove</button>
        </div>`;
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

function nutriBar(value, target, limit) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  let cls = "ok";
  if (limit) cls = value > target ? "high" : "ok";
  else if (value < target * 0.85) cls = "low";
  else if (value > target * 1.25) cls = "high";
  return `<div class="nutri-bar"><div class="nutri-fill ${cls}" style="width:${pct.toFixed(0)}%"></div></div>`;
}

function renderNutritionSummary(day) {
  const el = document.getElementById("nutri-summary");
  const st = NUTRI_STATUS[day.status] || NUTRI_STATUS.in_limit;
  const { intake, targets, burn } = day;
  const balance = day.balance > 0 ? `+${nutriFmt(day.balance)}` : nutriFmt(day.balance);
  const srcNote = {
    garmin: "Burn from Garmin (BMR + active calories)",
    strava: "Workouts from Strava; BMR estimated",
    estimate: "Burn estimated — connect Garmin for accurate numbers",
  }[burn.source] || "";
  const workouts = day.workouts.length
    ? day.workouts
        .map((w) => `<li>${escapeAttr(w.name || w.type)} · ${w.minutes} min · ${w.estimated ? "~" : ""}${nutriFmt(w.kcal, " kcal")}</li>`)
        .join("")
    : `<li class="dim">No workout recorded${day.inProgress ? " yet" : ""}.</li>`;

  el.innerHTML = `
    <div class="nutri-head">
      <div>
        <div class="nutri-kcal">${nutriFmt(intake.kcal)} <small>/ ${nutriFmt(targets.kcal)} kcal</small></div>
        <div class="dim">Balance ${balance} kcal${day.inProgress ? " · day in progress" : ""}</div>
      </div>
      <span class="nutri-status ${st.cls}">${st.label}</span>
    </div>
    ${nutriBar(intake.kcal, targets.kcal)}
    <div class="nutri-macros">
      ${NUTRI_ROWS.map(
        (r) => `
        <div class="nutri-macro">
          <div class="nm-lab"><span>${r.label}</span>
            <span>${nutriFmt(intake[r.key])} / ${r.limit ? "≤ " : ""}${nutriFmt(targets[r.key], " " + r.unit)}</span></div>
          ${nutriBar(intake[r.key], targets[r.key], r.limit)}
        </div>`
      ).join("")}
    </div>
    <div class="nutri-burn">
      <div class="dim">${srcNote}</div>
      <div>🔥 BMR ${nutriFmt(burn.bmr)} + active ${nutriFmt(burn.active)} = <b>${nutriFmt(burn.total)} kcal</b>
        · ⚖️ ${day.weightKg} kg</div>
      <ul class="nutri-workouts">${workouts}</ul>
    </div>
    ${
      day.entries.length
        ? `<h3 class="nutri-sub">Suggestions</h3>
           <ul class="nutri-tips">${day.suggestions.map((t) => `<li>${escapeAttr(t)}</li>`).join("")}</ul>`
        : ""
    }`;
}

async function submitNutrition(e) {
  e.preventDefault();
  const input = document.getElementById("nutri-input");
  const btn = document.getElementById("nutri-send");
  const text = input.value.trim();
  if (!text) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await api("/api/nutrition/log", {
      method: "POST",
      body: JSON.stringify({ text, date: document.getElementById("nutri-date").value || null }),
    });
    input.value = "";
    renderNutritionDay(res.day);
  } catch (ex) {
    toast(`Could not log meal: ${ex.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Log";
  }
}

async function deleteNutritionEntry(id) {
  try {
    await api(`/api/nutrition/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
    loadNutrition();
  } catch (ex) {
    toast(`Could not delete: ${ex.message}`);
  }
}

// ------------------------------------------------------------- history

async function openNutritionHistory() {
  document.getElementById("nutri-history-modal").classList.remove("hidden");
  document
    .querySelectorAll("#nutri-history-periods button")
    .forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === nutriHistoryDays));
  try {
    const { days } = await api(`/api/nutrition/history?days=${nutriHistoryDays}`);
    renderNutritionHistory(days);
  } catch (ex) {
    document.getElementById("nutri-history-table").innerHTML =
      `<div class="empty">Could not load history: ${escapeAttr(ex.message)}</div>`;
  }
}

function renderNutritionHistory(days) {
  const empty = !days.length;
  document.getElementById("nutri-history-empty").classList.toggle("hidden", !empty);
  const canvas = document.getElementById("nutri-history-chart");
  canvas.classList.toggle("hidden", empty);
  if (nutriHistoryChart) nutriHistoryChart.destroy();
  nutriHistoryChart = null;
  if (empty) {
    document.getElementById("nutri-history-table").innerHTML = "";
    return;
  }
  nutriHistoryChart = new Chart(canvas, {
    data: {
      labels: days.map((d) => d.date.slice(5)),
      datasets: [
        { type: "bar", label: "Intake kcal", data: days.map((d) => d.intake.kcal), backgroundColor: "rgba(45,212,191,0.6)" },
        { type: "line", label: "Burn kcal", data: days.map((d) => d.burn?.total ?? null), borderColor: "#f59e0b", tension: 0.3, spanGaps: true },
        { type: "line", label: "Protein g", data: days.map((d) => d.intake.protein), borderColor: "#60a5fa", yAxisID: "y1", tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#9fb0cc" } } },
      scales: {
        x: { ticks: { color: "#9fb0cc" }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "#9fb0cc" }, grid: { color: "rgba(255,255,255,0.05)" }, title: { display: true, text: "kcal", color: "#9fb0cc" } },
        y1: { position: "right", ticks: { color: "#60a5fa" }, grid: { display: false }, title: { display: true, text: "protein g", color: "#60a5fa" } },
      },
    },
  });
  const rows = [...days]
    .reverse()
    .map((d) => {
      const st = NUTRI_STATUS[d.status];
      return `<tr><td>${escapeAttr(d.date)}</td><td>${nutriFmt(d.intake.kcal)}</td><td>${nutriFmt(d.burn?.total)}</td>
        <td>${nutriFmt(d.intake.protein)}</td><td>${nutriFmt(d.intake.carbs)}</td><td>${nutriFmt(d.intake.fat)}</td>
        <td>${nutriFmt(d.intake.fiber)}</td><td>${st ? `<span class="nutri-status ${st.cls}">${st.label}</span>` : "–"}</td></tr>`;
    })
    .join("");
  document.getElementById("nutri-history-table").innerHTML = `
    <table class="nutri-items nutri-history">
      <thead><tr><th>Date</th><th>Intake</th><th>Burn</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Fiber</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function closeNutritionHistory() {
  document.getElementById("nutri-history-modal").classList.add("hidden");
}

// ------------------------------------------------------------- wiring

document.getElementById("nutri-form").addEventListener("submit", submitNutrition);
document.getElementById("nutri-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("nutri-form").requestSubmit();
  }
});
document.getElementById("nutri-date").addEventListener("change", loadNutrition);
document.getElementById("nutri-messages").addEventListener("click", (e) => {
  const btn = e.target.closest(".nutri-del");
  if (btn) deleteNutritionEntry(btn.dataset.id);
});
document.getElementById("nutri-history-btn").addEventListener("click", openNutritionHistory);
document.getElementById("nutri-history-close").addEventListener("click", closeNutritionHistory);
document.getElementById("nutri-history-modal").addEventListener("click", (e) => {
  if (e.target.id === "nutri-history-modal") closeNutritionHistory();
});
document.getElementById("nutri-history-periods").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  nutriHistoryDays = Number(b.dataset.days);
  openNutritionHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeNutritionHistory();
});
