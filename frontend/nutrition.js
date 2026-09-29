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
    box.innerHTML = `<div class="nutri-bot dim">Tell me what you ate — e.g. "2 idli with 1 cup sambar", "1 scoop iso whey".</div>`;
    return;
  }
  box.innerHTML = day.entries
    .map((e) => {
      const id = escapeAttr(e.id);
      if (e.revoked) {
        return `<div class="nutri-user revoked">${escapeAttr(e.text)}
          <button class="nutri-act nutri-restore" data-id="${id}" title="Restore entry">↩</button></div>`;
      }
      const items = e.items
        .map((i, idx) => {
          if (!i.found) {
            return `<span class="nutri-chip miss">❓ ${escapeAttr(i.input)}
              <button class="nutri-act nutri-retry" data-id="${id}" title="Analyse again">↻</button></span>`;
          }
          const tip = `${i.qty} ${i.unit} · ${nutriFmt(i.grams)} g · P ${i.protein} · C ${i.carbs} · F ${i.fat} · Fib ${i.fiber}`;
          const act = i.revoked
            ? `<button class="nutri-act nutri-restore" data-id="${id}" data-item="${idx}" title="Restore">↩</button>`
            : `<button class="nutri-act nutri-revoke" data-id="${id}" data-item="${idx}" title="Remove">×</button>`;
          return `<span class="nutri-chip${i.revoked ? " revoked" : ""}" title="${escapeAttr(tip)}">${escapeAttr(i.name)} ×${i.qty}
            <b>${nutriFmt(i.kcal)}</b>${act}</span>`;
        })
        .join("");
      return `
        <div class="nutri-user">${escapeAttr(e.text)}</div>
        <div class="nutri-bot">${items}<span class="nutri-total">= ${nutriFmt(e.totals.kcal)} kcal</span>
          <button class="nutri-act nutri-revoke" data-id="${id}" title="Remove entry">🗑</button></div>`;
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

function renderNutritionSummary(day) {
  const el = document.getElementById("nutri-summary");
  const st = NUTRI_STATUS[day.status] || NUTRI_STATUS.in_limit;
  const { intake, targets } = day;
  const cell = (key) => {
    const v = intake[key], t = targets[key];
    const bad = key === "sugar" || key === "sodium" ? v > t : v > t * 1.25;
    return `<td class="${bad ? "over" : ""}">${nutriFmt(v)}</td>`;
  };
  const tips = day.entries.length ? day.suggestions.join("\n\n") : "";
  el.innerHTML = `
    <table class="nutri-table">
      <thead><tr><th></th><th>kcal</th>${NUTRI_ROWS.map((r) => `<th>${r.label} <small>${r.unit}</small></th>`).join("")}<th></th></tr></thead>
      <tbody>
        <tr><td>Today</td>${cell("kcal")}${NUTRI_ROWS.map((r) => cell(r.key)).join("")}
          <td rowspan="2"><span class="nutri-status ${st.cls}" title="${escapeAttr(tips)}">${st.label}${tips ? " ⓘ" : ""}</span></td></tr>
        <tr class="dim"><td>Target</td><td>${nutriFmt(targets.kcal)}</td>${NUTRI_ROWS.map((r) => `<td>${r.limit ? "≤" : ""}${nutriFmt(targets[r.key])}</td>`).join("")}</tr>
      </tbody>
    </table>`;
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

async function setNutritionRevoked(id, item, revoke) {
  const q = item != null && item !== "" ? `?item=${encodeURIComponent(item)}` : "";
  const path = `/api/nutrition/entries/${encodeURIComponent(id)}${revoke ? "" : "/restore"}${q}`;
  try {
    await api(path, { method: revoke ? "DELETE" : "POST" });
    loadNutrition();
  } catch (ex) {
    toast(`Could not ${revoke ? "revoke" : "restore"}: ${ex.message}`);
  }
}

async function reanalyseNutritionEntry(id) {
  try {
    await api(`/api/nutrition/entries/${encodeURIComponent(id)}/reanalyse`, { method: "POST" });
    loadNutrition();
  } catch (ex) {
    toast(`Could not re-analyse: ${ex.message}`);
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
  canvas.parentElement.classList.toggle("hidden", empty);
  if (nutriHistoryChart) nutriHistoryChart.destroy();
  nutriHistoryChart = null;
  if (empty) {
    document.getElementById("nutri-history-table").innerHTML = "";
    return;
  }
  const tick = { color: "#9fb0cc", font: { size: 10 } };
  nutriHistoryChart = new Chart(canvas, {
    data: {
      labels: days.map((d) => d.date.slice(5)),
      datasets: [
        { type: "bar", label: "Intake kcal", data: days.map((d) => d.intake.kcal), backgroundColor: "rgba(45,212,191,0.6)", maxBarThickness: 24 },
        { type: "line", label: "Burn kcal", data: days.map((d) => d.burn?.total ?? null), borderColor: "#f59e0b", tension: 0.3, spanGaps: true, pointRadius: 2 },
        { type: "line", label: "Protein g", data: days.map((d) => d.intake.protein), borderColor: "#60a5fa", yAxisID: "y1", tension: 0.3, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#9fb0cc", boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { ticks: tick, grid: { display: false } },
        y: { ticks: tick, grid: { color: "rgba(255,255,255,0.05)" } },
        y1: { position: "right", ticks: { ...tick, color: "#60a5fa" }, grid: { display: false } },
      },
    },
  });
  const list = [...days]
    .reverse()
    .map((d) => {
      const st = NUTRI_STATUS[d.status];
      const label = new Date(`${d.date}T00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      const items = (d.items || [])
        .map((i) => `<span class="nutri-chip">${escapeAttr(i.name)} ×${i.qty}<b>${nutriFmt(i.kcal)}</b></span>`)
        .join("");
      return `
        <div class="nh-day">
          <div class="nh-head">
            <b>${escapeAttr(label)}</b>
            <span>${nutriFmt(d.intake.kcal)}${d.burn?.total ? ` / ${nutriFmt(d.burn.total)}` : ""} kcal</span>
            <span class="dim">P ${nutriFmt(d.intake.protein)} · C ${nutriFmt(d.intake.carbs)} · F ${nutriFmt(d.intake.fat)} · Fib ${nutriFmt(d.intake.fiber)}</span>
            ${st ? `<span class="nutri-status ${st.cls}">${st.label}</span>` : ""}
          </div>
          <div class="nh-items">${items || '<span class="dim">No items</span>'}</div>
        </div>`;
    })
    .join("");
  document.getElementById("nutri-history-table").innerHTML = `<div class="nutri-history">${list}</div>`;
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
  const btn = e.target.closest(".nutri-act");
  if (!btn) return;
  if (btn.classList.contains("nutri-retry")) reanalyseNutritionEntry(btn.dataset.id);
  else setNutritionRevoked(btn.dataset.id, btn.dataset.item, btn.classList.contains("nutri-revoke"));
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
