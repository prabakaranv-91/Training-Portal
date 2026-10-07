let today = localDate();
let selectedDate = today;
let currentDay = null;
let busy = false;
let foodDetailsVisible = false;
let toastTimer;

const $ = (selector) => document.querySelector(selector);

function localDate(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function number(value) {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Your session expired. Sign in again to continue.");
    }
    throw new Error(payload.detail || payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function friendlyDate(value, options = { weekday: "long", day: "numeric", month: "long" }) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, options);
}

async function initialize() {
  today = localDate();
  $("#food-date").value = today;
  $("#food-date").max = today;
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      $("#conversation").innerHTML = "";
      $("#auth-notice").hidden = false;
      $("#composer-wrap").hidden = true;
      $("#insight-rail").hidden = true;
      $("#day-caption").textContent = "Sign in required";
      return;
    }
    $("#insight-rail").hidden = false;
    await Promise.all([loadRecentDays(), loadDay(today)]);
  } catch (error) {
    showError(error.message);
  }
}

async function loadRecentDays() {
  try {
    const { days } = await api("/api/nutrition/history?days=30");
    const items = [...days].reverse().slice(0, 12);
    $("#recent-days").innerHTML = items.length ? items.map((day) => {
      const dateLabel = friendlyDate(day.date, { weekday: "short", day: "numeric", month: "short" });
      return `<button class="recent-day${day.date === selectedDate ? " active" : ""}" type="button" data-date="${escapeHtml(day.date)}">
        <span>${escapeHtml(dateLabel)}</span><span class="recent-kcal">${number(day.intake.kcal)} kcal</span>
      </button>`;
    }).join("") : `<div class="sidebar-empty">Your logged days will appear here.</div>`;
  } catch (_) {
    $("#recent-days").innerHTML = `<div class="sidebar-empty">Recent days unavailable.</div>`;
  }
}

async function loadDay(date) {
  if (date > today) return;
  foodDetailsVisible = false;
  $("#food-details-btn").setAttribute("aria-expanded", "false");
  $("#food-details-btn").querySelector("span:nth-child(2)").textContent = "Show food details";
  selectedDate = date;
  $("#food-date").value = date;
  $("#day-caption").textContent = `${friendlyDate(date)}${date === today ? " · Today" : ""}`;
  $("#conversation").innerHTML = `<div class="loading-state"><span class="spinner"></span><span>Loading food log…</span></div>`;
  $("#send-btn").disabled = true;
  document.querySelectorAll(".recent-day").forEach((button) => button.classList.toggle("active", button.dataset.date === date));
  try {
    currentDay = await api(`/api/nutrition/day?date=${encodeURIComponent(date)}`);
    renderDay(currentDay);
    await loadReview(currentDay);
  } catch (error) {
    currentDay = null;
    if (error.message.includes("session expired")) {
      $("#conversation").innerHTML = "";
      $("#auth-notice").hidden = false;
      $("#composer-wrap").hidden = true;
      $("#insight-rail").hidden = true;
    } else {
      showError(error.message);
    }
  } finally {
    $("#send-btn").disabled = busy || !currentDay;
  }
}

function renderDay(day) {
  renderBalance(day);
  const entries = day.entries || [];
  const dateLabel = friendlyDate(day.date, { weekday: "long", day: "numeric", month: "long" });
  const empty = `<div class="conversation-empty"><div class="empty-orbit" aria-hidden="true">✳</div>
    <h2>What have you eaten?</h2>
    <p>Describe a meal in your own words. Portions, ingredients, or a quick snack—all are welcome.</p>
  </div>`;
  $("#conversation").innerHTML = `<div class="day-intro">${escapeHtml(dateLabel)}</div>` +
    (entries.length ? entries.map(renderEntry).join("") : empty) +
    (foodDetailsVisible ? renderFoodDetails(day) : "");
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
}

function renderFoodDetails(day) {
  const grouped = new Map();
  for (const entry of day.entries || []) {
    if (entry.revoked) continue;
    for (const item of entry.items || []) {
      if (!item.found || item.revoked) continue;
      const key = `${item.name}\u0000${item.unit || ""}`;
      const food = grouped.get(key) || { name: item.name, unit: item.unit || "", qty: 0, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
      food.qty += Number(item.qty) || 0;
      for (const nutrient of ["kcal", "protein", "carbs", "fat", "fiber"]) food[nutrient] += Number(item[nutrient]) || 0;
      grouped.set(key, food);
    }
  }
  const foods = [...grouped.values()].sort((a, b) => b.kcal - a.kcal);
  const rows = foods.map(food => `<tr class="day-food-row">
    <th scope="row">${escapeHtml(food.name)}</th>
    <td class="day-food-portion">${escapeHtml(food.qty.toLocaleString(undefined, { maximumFractionDigits: 2 }))} ${escapeHtml(food.unit)}</td>
    <td class="day-food-kcal">${number(food.kcal)}<span class="day-food-mobile-unit"> kcal</span></td>
    ${[["protein", "Protein"], ["carbs", "Carbs"], ["fat", "Fat"], ["fiber", "Fibre"]].map(([key, label]) =>
      `<td class="day-food-nutrient" data-label="${label}">${number(food[key])}<span class="day-food-mobile-unit"> g</span></td>`).join("")}
  </tr>`).join("");
  return `<article class="day-food-details"><header><div><h2>Food details</h2>
    <p>${escapeHtml(friendlyDate(day.date))} · ${foods.length} ${foods.length === 1 ? "food" : "foods"}</p></div>
    <div class="day-food-total"><b>${number(day.intake?.kcal)}</b><span>kcal total</span></div></header>
    ${foods.length ? `<table class="day-food-list"><caption class="sr-only">Foods and nutrition for ${escapeHtml(friendlyDate(day.date))}</caption>
      <thead><tr><th scope="col">Food</th><th scope="col">Portion</th><th scope="col">kcal</th><th scope="col">Protein (g)</th><th scope="col">Carbs (g)</th><th scope="col">Fat (g)</th><th scope="col">Fibre (g)</th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<p class="day-food-empty">No matched foods logged for this day.</p>`}</article>`;
}

function renderEntry(entry) {
  const entryId = escapeHtml(entry.id);
  if (entry.revoked) {
    return `<article class="entry-thread"><div class="user-message revoked-message">${escapeHtml(entry.text)}</div>
      <div class="thread-meta"><span>Entry removed</span><button class="thread-action" data-action="restore-entry" data-id="${entryId}">Restore</button></div></article>`;
  }
  const items = (entry.items || []).map((item, index) => {
    if (!item.found) {
      return `<div class="food-item unknown"><span class="food-name">? ${escapeHtml(item.input || item.name)}</span>
        <span class="food-portion">Unmatched</span><span class="food-kcal">—</span>
        <button class="food-action" type="button" title="Analyse again" aria-label="Analyse this food again" data-action="reanalyze" data-id="${entryId}">↻</button></div>`;
    }
    const rating = { best: "★", good: "✓", ok: "·", avoid: "⊘" }[item.rating] || "";
    const portion = `${item.qty ?? ""} ${item.unit || ""}`.trim();
    const detail = `${portion}${item.grams ? ` · ${number(item.grams)} g` : ""} · ${number(item.kcal)} kcal`;
    return `<div class="food-item${item.revoked ? " item-revoked" : ""}" title="${escapeHtml(`${item.ratingWhy || ""} ${detail}`.trim())}">
      <span class="food-name"><span class="food-rating rating-${escapeHtml(item.rating || "neutral")}">${rating}</span>${escapeHtml(item.name)}</span>
      <span class="food-portion">${escapeHtml(portion)}</span><span class="food-kcal">${number(item.kcal)} <small>kcal</small></span>
      <button class="food-action" type="button" title="${item.revoked ? "Restore food" : "Remove food"}" aria-label="${item.revoked ? "Restore" : "Remove"} ${escapeHtml(item.name)}"
        data-action="${item.revoked ? "restore-item" : "remove-item"}" data-id="${entryId}" data-item="${index}">${item.revoked ? "↶" : "×"}</button></div>`;
  }).join("");
  return `<article class="entry-thread" data-entry="${entryId}">
    <div class="user-message">${escapeHtml(entry.text)}</div>
    <div class="food-response"><div class="response-head"><span class="response-glyph">✳</span><span>Meal breakdown</span>
      <span class="response-total">${number(entry.totals?.kcal)} kcal</span></div><div class="food-list">${items}</div></div>
    <div class="thread-meta"><span>${escapeHtml(entry.time || "Logged")}</span><button class="thread-action" data-action="remove-entry" data-id="${entryId}">Remove entry</button></div>
  </article>`;
}

function renderBalance(day) {
  const intake = day.intake || {}, targets = day.targets || {};
  const kcal = intake.kcal || 0, target = targets.kcal || 0;
  const statusClass = { low: "low", in_limit: "ok", high: "high" }[day.status] || "";
  $("#status-badge").className = `status-badge ${statusClass}`;
  $("#status-badge").textContent = ({ low: "↓ Below target", in_limit: "✓ On plan", high: "↑ Over target" })[day.status] || "—";
  $("#calorie-count").textContent = `${number(kcal)} / ${number(target)}`;
  $("#target-count").textContent = `Target ${number(target)} kcal`;
  const difference = target - kcal;
  $("#calorie-balance").textContent = difference >= 0 ? `${number(difference)} kcal remaining` : `${number(-difference)} kcal over`;
  $("#calorie-balance").className = difference >= 0 ? "under" : "over";
  $("#calorie-fill").style.width = `${target ? Math.min(100, kcal / target * 100) : 0}%`;
  $("#calorie-fill").classList.toggle("over", kcal > target);
  const macros = [["Protein", "protein", "g"], ["Carbs", "carbs", "g"], ["Fat", "fat", "g"], ["Fibre", "fiber", "g"]];
  $("#macro-list").innerHTML = macros.map(([label, key, unit]) => {
    const value = intake[key] || 0, goal = targets[key] || 0;
    const state = goal && value >= goal ? value > goal * 1.1 ? "over" : "met" : "";
    return `<div class="macro-row"><span>${label}</span><b class="${state}">${number(value)} <i>/ ${number(goal)} ${unit}</i></b></div>`;
  }).join("");
  const burn = day.burn || {};
  const delta = target - (burn.total || 0);
  $("#burn-breakdown").innerHTML = `<div class="burn-row"><span>Resting</span><b>${number(burn.bmr)} kcal</b></div>
    <div class="burn-row"><span>Active</span><b>${number(burn.active)} kcal</b></div>
    <div class="burn-row"><span>Total burn</span><b>${number(burn.total)} kcal</b></div>
    <div class="burn-row"><span>Workout (included in active)</span><b>${number(burn.workoutKcal)} kcal</b></div>
    <div class="burn-row"><span>${escapeHtml(day.programLabel || "Program")}</span><b>${delta < 0 ? "−" : "+"}${number(Math.abs(delta))} kcal</b></div>
    <div class="burn-row"><span>Target calculation</span><b>${number(burn.total)} ${delta < 0 ? "−" : "+"} ${number(Math.abs(delta))} = ${number(target)} kcal</b></div>`;
}

async function loadReview(day, refresh = false) {
  const card = $("#review-card");
  card.innerHTML = `<span class="spinner"></span><span>Preparing review…</span>`;
  try {
    const review = await api(`/api/nutrition/coach?date=${encodeURIComponent(day.date)}${refresh ? "&refresh=true" : ""}`);
    if (!review || review.source !== "gemini") {
      const tips = day.cutTips || [];
      card.textContent = tips[0] || "Log a meal to get a day review.";
      return;
    }
    const avoid = (review.avoid || []).map(item => `<li><b>${escapeHtml(item.item)}</b> — ${escapeHtml(item.reason)} <span>→ ${escapeHtml(item.instead)}</span></li>`).join("");
    const add = (review.add || []).map(item => `<li><b>${escapeHtml(item.food)}</b> · ${escapeHtml(item.portion)} <span>— ${escapeHtml(item.why)}</span></li>`).join("");
    card.innerHTML = `<p class="review-summary">${escapeHtml(review.summary || "Review ready.")}</p>
      ${review.stale ? `<button class="review-retry" type="button" data-action="refresh-review">↻ Update review</button>` : ""}
      ${(avoid || add || review.next) ? `<details class="review-details"><summary>Show details</summary>${avoid ? `<b>Avoid</b><ul>${avoid}</ul>` : ""}${add ? `<b>Eat next</b><ul>${add}</ul>` : ""}${review.next ? `<div class="review-next">${escapeHtml(review.next)}</div>` : ""}</details>` : ""}`;
  } catch (_) {
    card.textContent = "Day review is temporarily unavailable.";
  }
}

function showError(message) {
  $("#conversation").innerHTML = `<div class="auth-notice"><div class="notice-mark">!</div><div><b>Could not load this day</b><p>${escapeHtml(message)}</p></div></div>`;
}

async function submitFood(event) {
  event.preventDefault();
  if (busy) return;
  const input = $("#food-input");
  const text = input.value.trim();
  if (!text) return;
  busy = true;
  $("#send-btn").disabled = true;
  const pending = document.createElement("article");
  pending.className = "entry-thread pending-entry";
  pending.innerHTML = `<div class="user-message">${escapeHtml(text)}</div><div class="typing-dots" aria-label="Analysing food"><i></i><i></i><i></i><span>Working out the meal…</span></div>`;
  $("#conversation").append(pending);
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
  input.value = "";
  resizeComposer();
  try {
    const result = await api("/api/nutrition/log", { method: "POST", body: JSON.stringify({ text, date: selectedDate }) });
    currentDay = result.day;
    renderDay(currentDay);
    await loadReview(currentDay);
    await loadRecentDays();
  } catch (error) {
    pending.remove();
    input.value = text;
    resizeComposer();
    toast(error.message);
  } finally {
    busy = false;
    $("#send-btn").disabled = false;
    input.focus();
  }
}

async function performAction(button) {
  const { action, id, item } = button.dataset;
  if (action === "refresh-review") return loadReview(currentDay, true);
  if (["remove-entry", "remove-item"].includes(action) && !confirm("Remove this logged food?")) return;
  button.disabled = true;
  try {
    if (action === "remove-entry" || action === "remove-item") {
      const query = action === "remove-item" ? `?item=${encodeURIComponent(item)}` : "";
      await api(`/api/nutrition/entries/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
    } else if (action === "restore-entry" || action === "restore-item") {
      const query = action === "restore-item" ? `?item=${encodeURIComponent(item)}` : "";
      await api(`/api/nutrition/entries/${encodeURIComponent(id)}/restore${query}`, { method: "POST" });
    } else if (action === "reanalyze") {
      await api(`/api/nutrition/entries/${encodeURIComponent(id)}/reanalyse`, { method: "POST" });
    }
    await loadDay(selectedDate);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

function resizeComposer() {
  const input = $("#food-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

$("#food-form").addEventListener("submit", submitFood);
$("#food-input").addEventListener("input", resizeComposer);
$("#food-input").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#food-form").requestSubmit();
  }
});
$("#food-date").addEventListener("change", event => loadDay(event.target.value));
$("#today-btn").addEventListener("click", () => loadDay(today));
$("#food-details-btn").addEventListener("click", () => {
  if (!currentDay) return;
  foodDetailsVisible = !foodDetailsVisible;
  $("#food-details-btn").setAttribute("aria-expanded", String(foodDetailsVisible));
  $("#food-details-btn").querySelector("span:nth-child(2)").textContent = foodDetailsVisible ? "Hide food details" : "Show food details";
  const existing = $("#conversation .day-food-details");
  if (foodDetailsVisible && !existing) $("#conversation").insertAdjacentHTML("beforeend", renderFoodDetails(currentDay));
  else if (!foodDetailsVisible) existing?.remove();
  if (foodDetailsVisible) $("#conversation .day-food-details")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#recent-days").addEventListener("click", event => {
  const button = event.target.closest("[data-date]");
  if (button) loadDay(button.dataset.date);
});
$("#conversation").addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) performAction(button);
});

initialize();