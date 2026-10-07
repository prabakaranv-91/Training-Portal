let today = localDate();
let selectedDate = today;
let currentDay = null;
let busy = false;
let foodDetailsVisible = false;
let contributorsNutrient = null;
let toastTimer;
let weightData = null;
let weightChart = null;

const $ = (selector) => document.querySelector(selector);
const FOOD_RATINGS = {
  best: { symbol: "★", label: "Highly recommended", priority: 1 },
  good: { symbol: "✓", label: "Good choice", priority: 2 },
  ok: { symbol: "•", label: "Moderate", priority: 3 },
  avoid: { symbol: "⊘", label: "Avoid", priority: 4 },
};

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
  $("#day-caption").textContent = friendlyDate(today, { weekday: "short", day: "numeric", month: "short" });
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      $("#conversation").innerHTML = "";
      $("#auth-notice").hidden = false;
      $("#composer-wrap").hidden = true;
      $("#insight-rail").hidden = true;
      return;
    }
    $("#insight-rail").hidden = false;
    await Promise.all([loadRecentDays(), loadDay(today), loadWeight()]);
  } catch (error) {
    showError(error.message);
  }
}

async function loadWeight() {
  try {
    weightData = await api("/api/nutrition/weight");
    renderWeight();
  } catch (_) {
    $("#weight-chart-wrap").hidden = true;
    $("#weight-chart-message").hidden = false;
    $("#weight-chart-message").textContent = "Weight history unavailable.";
  }
}

function renderWeight() {
  if (!weightData) return;
  const period = $("#weight-period").value;
  const start = new Date(`${today}T00:00:00`);
  if (period !== "all") start.setDate(start.getDate() - Number(period) + 1);
  const cutoff = period === "all" ? "" : localDate(start);
  const points = [...(weightData.history || [])]
    .filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(Number(point.kg)) && Number(point.kg) > 0 && point.date >= cutoff && point.date <= today)
    .sort((first, second) => first.date.localeCompare(second.date));
  const external = weightData.externalKg ?? weightData.garminKg;
  const current = external ?? weightData.current?.kg;
  $("#weight-current").textContent = current != null ? `${Number(current).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg` : "—";
  $("#weight-source").textContent = external != null ? ({ garmin: "Garmin Connect", strava: "Strava" }[weightData.weightSource] || "Synced") : weightData.current ? "Logged" : "";
  const change = points.length > 1 ? Number(points.at(-1).kg) - Number(points[0].kg) : null;
  $("#weight-note").textContent = change != null ? `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg · ${points.length} weigh-ins` : points.length ? "1 weigh-in · kg" : "";
  weightChart?.destroy();
  weightChart = null;
  const available = points.length > 0 && typeof Chart === "function";
  $("#weight-chart-wrap").hidden = !available;
  $("#weight-chart-message").hidden = available;
  $("#weight-chart-message").textContent = points.length ? "Weight chart unavailable." : "No weigh-ins in this period.";
  if (!available) return;
  $("#weight-chart").setAttribute("aria-label", `Weight history: ${points.map(point => `${friendlyDate(point.date)}: ${point.kg} kg`).join("; ")}`);
  weightChart = new Chart($("#weight-chart"), {
    type: "line",
    data: { labels: points.map(point => point.date), datasets: [{ data: points.map(point => Number(point.kg)), borderColor: "#75c9f2", backgroundColor: "#75c9f2", borderWidth: 2, pointRadius: points.length === 1 ? 4 : 2, pointHoverRadius: 4, tension: .2, fill: false }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { displayColors: false, padding: 4, caretSize: 3, bodyFont: { size: 10 }, callbacks: { title: () => [], label: item => `${friendlyDate(item.label, { day: "numeric", month: "short", year: "numeric" })} · ${item.parsed.y} kg` } } },
      scales: {
        x: { display: false },
        y: { display: false, grace: "20%" },
      },
    },
  });
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
  contributorsNutrient = null;
  $("#food-details-btn").setAttribute("aria-expanded", "false");
  $("#food-details-btn").querySelector("span:nth-child(2)").textContent = "Show food details";
  selectedDate = date;
  $("#food-date").value = date;
  $("#day-caption").textContent = friendlyDate(date, { weekday: "short", day: "numeric", month: "short" });
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
    (foodDetailsVisible ? renderFoodDetails(day) : "") +
    (contributorsNutrient ? renderNutrientContributors(day, contributorsNutrient) : "");
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
}

function renderFoodRating(food) {
  if (!Object.hasOwn(FOOD_RATINGS, food.rating)) return "";
  const rating = FOOD_RATINGS[food.rating];
  return `<span class="food-rating rating-${food.rating}" role="img" aria-label="${rating.label}" title="${escapeHtml(`${rating.label}${food.ratingWhy ? `: ${food.ratingWhy}` : ""}`)}">${rating.symbol}</span>`;
}

function dailyFoods(day) {
  const grouped = new Map();
  for (const entry of day.entries || []) {
    if (entry.revoked) continue;
    for (const [index, item] of (entry.items || []).entries()) {
      if (!item.found || item.revoked) continue;
      const key = `${item.name}\u0000${item.unit || ""}`;
      const food = grouped.get(key) || { name: item.name, unit: item.unit || "", qty: 0, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sources: [] };
      food.qty += Number(item.qty) || 0;
      food.sources.push({ entryId: entry.id, index, item, time: entry.time });
      if ((FOOD_RATINGS[item.rating]?.priority || 0) > (FOOD_RATINGS[food.rating]?.priority || 0)) {
        food.rating = item.rating;
        food.ratingWhy = item.ratingWhy;
      }
      for (const nutrient of ["kcal", "protein", "carbs", "fat", "fiber"]) food[nutrient] += Number(item[nutrient]) || 0;
      grouped.set(key, food);
    }
  }
  return [...grouped.values()];
}

function renderFoodDetails(day) {
  const foods = dailyFoods(day).sort((first, second) => second.kcal - first.kcal);
  const rows = foods.map((food, index) => `<tr class="day-food-row">
    <th scope="row"><button class="food-inspect-btn" type="button" data-action="toggle-food-info" data-panel="daily-food-${index}" aria-controls="daily-food-${index}" aria-expanded="false" title="Nutrition details for ${escapeHtml(food.name)}"><span aria-hidden="true">▸</span>${renderFoodRating(food)}<span>${escapeHtml(food.name)}</span></button></th>
    <td class="day-food-portion"><button class="food-qty-btn" type="button" data-action="edit-qty" data-panel="daily-food-${index}" title="Edit portions" aria-label="Edit quantity of ${escapeHtml(food.name)}">${escapeHtml(food.qty.toLocaleString(undefined, { maximumFractionDigits: 2 }))} ${escapeHtml(food.unit)}</button></td>
    <td class="day-food-kcal">${number(food.kcal)}<span class="day-food-mobile-unit"> kcal</span></td>
    ${[["protein", "Protein", "P"], ["carbs", "Carbs", "C"], ["fat", "Fat", "F"], ["fiber", "Fibre", "Fib"]].map(([key, label, short]) =>
      `<td class="day-food-nutrient" data-label="${label}" data-short="${short}" aria-label="${label}: ${number(food[key])} grams">${number(food[key])}<span class="day-food-mobile-unit"> g</span></td>`).join("")}
  </tr><tr id="daily-food-${index}" class="day-food-expanded" hidden><td colspan="7">${renderFoodPanel(food, food.sources)}</td></tr>`).join("");
  return `<article class="day-food-details"><header><div><h2>Food details</h2>
    <p>${escapeHtml(friendlyDate(day.date))} · ${foods.length} ${foods.length === 1 ? "food" : "foods"}</p></div>
    <div class="day-food-total"><b>${number(day.intake?.kcal)}</b><span>kcal total</span></div></header>
    ${foods.length ? `<table class="day-food-list"><caption class="sr-only">Foods and nutrition for ${escapeHtml(friendlyDate(day.date))}</caption>
      <thead><tr><th scope="col">Food</th><th scope="col">Portion</th><th scope="col">kcal</th><th scope="col">Protein (g)</th><th scope="col">Carbs (g)</th><th scope="col">Fat (g)</th><th scope="col">Fibre (g)</th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<p class="day-food-empty">No matched foods logged for this day.</p>`}</article>`;
}

function renderNutrientContributors(day, nutrient) {
  const labels = { protein: "Protein", carbs: "Carbs", fat: "Fat", fiber: "Fibre" };
  const label = labels[nutrient];
  const foods = dailyFoods(day).filter(food => food[nutrient] > 0).sort((first, second) => second[nutrient] - first[nutrient]);
  const total = foods.reduce((sum, food) => sum + food[nutrient], 0);
  const format = value => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `<article class="nutrient-contributors" tabindex="-1"><header><div><h2>${label} contributors</h2><p>${escapeHtml(friendlyDate(day.date))} · ${format(total)} g logged</p></div>
    <button type="button" class="food-action" data-action="close-contributors" title="Close contributors" aria-label="Close contributors">×</button></header>
    ${foods.length ? `<ol class="contributor-list">${foods.map(food => `<li><div><b>${escapeHtml(food.name)}</b><small>${escapeHtml(format(food.qty))} ${escapeHtml(food.unit)}</small></div>
      <div class="contributor-value"><b>${format(food[nutrient])} g</b><small title="Share of ${label.toLowerCase()}" aria-label="${format(food[nutrient] / total * 100)}% of ${label.toLowerCase()}">${format(food[nutrient] / total * 100)}%</small></div></li>`).join("")}</ol>` : `<p class="day-food-empty">No foods contributed ${label.toLowerCase()} on this day.</p>`}</article>`;
}

function showNutrientContributors(nutrient) {
  if (!currentDay || currentDay.date !== selectedDate || !["protein", "carbs", "fat", "fiber"].includes(nutrient)) return;
  contributorsNutrient = nutrient;
  $("#conversation .nutrient-contributors")?.remove();
  $("#conversation").insertAdjacentHTML("beforeend", renderNutrientContributors(currentDay, nutrient));
  document.querySelectorAll(".nutrient-link").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.nutrient === nutrient)));
  const panel = $("#conversation .nutrient-contributors");
  panel.focus({ preventScroll: true });
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderFoodPanel(food, sources) {
  const reasons = [...new Map((sources.length ? sources.map(source => source.item) : [food])
    .filter(item => item.ratingWhy)
    .map(item => [`${item.rating}\u0000${item.ratingWhy}`, item])).values()];
  return `<div class="food-info-panel"><div class="food-nutrition-view">
    <dl class="food-info-macros" aria-label="Nutrition values">${[["Protein", "protein"], ["Carbs", "carbs"], ["Fat", "fat"], ["Fibre", "fiber"]].map(([label, key]) => `<div><dt>${label}</dt><dd>${number(food[key])} g</dd></div>`).join("")}</dl>
    ${reasons.map(item => `<p class="food-rating-note rating-${escapeHtml(item.rating || "neutral")}"><b>${FOOD_RATINGS[item.rating]?.label || "Food rating"}:</b> ${escapeHtml(item.ratingWhy)}</p>`).join("")}
    </div><div class="food-quantity-list" hidden>${sources.map(source => `<form class="food-quantity-form" data-id="${escapeHtml(source.entryId)}" data-item="${source.index}">
      <label>Quantity${sources.length > 1 ? ` · ${escapeHtml(source.time || "Logged portion")}` : ""}<input type="number" name="qty" min="0.01" max="10000" step="any" value="${escapeHtml(source.item.qty)}" required aria-label="Quantity of ${escapeHtml(food.name)}${source.time ? ` at ${escapeHtml(source.time)}` : ""}"></label>
      <span>${escapeHtml(source.item.unit || "portion")}</span><button type="submit" class="food-save-btn">Save</button>
    </form>`).join("")}</div></div>`;
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
    const portion = `${item.qty ?? ""} ${item.unit || ""}`.trim();
    const detail = `${portion}${item.grams ? ` · ${number(item.grams)} g` : ""} · ${number(item.kcal)} kcal`;
    const panelId = `entry-food-${entry.id}-${index}`;
    return `<div class="food-item${item.revoked ? " item-revoked" : ""}" title="${escapeHtml(`${item.ratingWhy || ""} ${detail}`.trim())}">
      <span class="food-name"><button class="food-inspect-btn" type="button" data-action="toggle-food-info" data-panel="${escapeHtml(panelId)}" aria-controls="${escapeHtml(panelId)}" aria-expanded="false" title="Nutrition details for ${escapeHtml(item.name)}"><span aria-hidden="true">▸</span>${renderFoodRating(item)}<span>${escapeHtml(item.name)}</span></button></span>
      <span class="food-portion">${item.revoked ? escapeHtml(portion) : `<button class="food-qty-btn" type="button" data-action="edit-qty" data-panel="${escapeHtml(panelId)}" title="Edit quantity" aria-label="Edit quantity of ${escapeHtml(item.name)}">${escapeHtml(portion)}</button>`}</span><span class="food-kcal">${number(item.kcal)} <small>kcal</small></span>
      <button class="food-action" type="button" title="${item.revoked ? "Restore food" : "Remove food"}" aria-label="${item.revoked ? "Restore" : "Remove"} ${escapeHtml(item.name)}"
        data-action="${item.revoked ? "restore-item" : "remove-item"}" data-id="${entryId}" data-item="${index}">${item.revoked ? "↶" : "×"}</button>
      <div id="${escapeHtml(panelId)}" class="food-inline-details" hidden>${renderFoodPanel(item, item.revoked ? [] : [{ entryId: entry.id, index, item }])}</div></div>`;
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
  const difference = target - kcal;
  $("#calorie-balance").textContent = difference === 0 ? "✓ Target reached" : difference > 0 ? `${number(difference)} kcal remaining` : `${number(-difference)} kcal over`;
  $("#calorie-balance").className = difference === 0 ? "met" : difference > 0 ? "under" : "over";
  $("#calorie-fill").style.width = `${target ? Math.min(100, kcal / target * 100) : 0}%`;
  $("#calorie-fill").className = statusClass;
  const macros = [["Protein", "protein", "g"], ["Carbs", "carbs", "g"], ["Fat", "fat", "g"], ["Fibre", "fiber", "g"]];
  const format = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
  $("#macro-list").innerHTML = `<table class="macro-table"><caption class="sr-only">Daily nutrients, targets and remaining grams</caption>
    <thead><tr><th scope="col">Nutrient</th><th scope="col">Logged</th><th scope="col">Target</th><th scope="col">Left</th></tr></thead><tbody>` + macros.map(([label, key, unit]) => {
    const value = intake[key] || 0, goal = targets[key] || 0;
    const remaining = goal - value;
    const state = goal ? remaining > 0 ? value / goal >= .9 ? "near" : "under" : remaining < 0 ? "over" : "met" : "";
    const status = { under: "Below 90% of target", near: "Almost reached", met: "Target reached", over: "Over target" }[state] || "Target unavailable";
    const left = !goal ? "—" : remaining > 0 ? `${format(remaining)} ${unit}` : remaining < 0 ? `${format(-remaining)} ${unit} over` : "✓ Met";
    return `<tr class="macro-row" data-nutrient="${key}"><th scope="row"><button class="nutrient-link" type="button" data-nutrient="${key}" aria-pressed="${contributorsNutrient === key}" aria-controls="conversation" title="Show ${label.toLowerCase()} contributors">${label}</button></th><td class="macro-logged ${state}" title="${status}">${format(value)} ${unit}</td><td class="macro-target">${goal ? `${format(goal)} ${unit}` : "—"}</td><td class="macro-left ${state}" title="${status}">${left}</td></tr>`;
  }).join("") + "</tbody></table>";
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
  if (action === "close-contributors") {
    const nutrient = contributorsNutrient;
    contributorsNutrient = null;
    $("#conversation .nutrient-contributors")?.remove();
    document.querySelectorAll(".nutrient-link").forEach(control => control.setAttribute("aria-pressed", "false"));
    document.querySelector(`.nutrient-link[data-nutrient="${nutrient}"]`)?.focus();
    return;
  }
  if (action === "toggle-food-info" || action === "edit-qty") {
    const panel = document.getElementById(button.dataset.panel);
    if (!panel) return;
    const nutrition = panel.querySelector(".food-nutrition-view");
    const quantities = panel.querySelector(".food-quantity-list");
    const editing = action === "edit-qty";
    panel.hidden = !panel.hidden && !(editing ? quantities : nutrition).hidden;
    nutrition.hidden = editing;
    quantities.hidden = !editing;
    document.querySelectorAll("[data-panel]").forEach(control => {
      if (control.dataset.panel === panel.id && control.hasAttribute("aria-expanded")) control.setAttribute("aria-expanded", String(!panel.hidden && !editing));
    });
    if (editing && !panel.hidden) panel.querySelector("input")?.focus();
    return;
  }
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

function setSidebarCollapsed(collapsed) {
  $(".food-shell").classList.toggle("sidebar-collapsed", collapsed);
  $("#food-sidebar").hidden = collapsed;
  $("#sidebar-open").hidden = !collapsed;
  $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebar-open").setAttribute("aria-expanded", String(!collapsed));
  $(collapsed ? "#sidebar-open" : "#sidebar-toggle").focus();
}

$("#sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(true));
$("#sidebar-open").addEventListener("click", () => setSidebarCollapsed(false));
$("#weight-period").addEventListener("change", renderWeight);
$("#conversation").addEventListener("submit", async event => {
  const form = event.target.closest(".food-quantity-form");
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const save = form.querySelector("button");
  if (save.disabled) return;
  const date = selectedDate;
  save.disabled = true;
  try {
    await api(`/api/nutrition/entries/${encodeURIComponent(form.dataset.id)}/items/${encodeURIComponent(form.dataset.item)}`, { method: "PATCH", body: JSON.stringify({ qty: Number(form.elements.qty.value) }) });
    const day = await api(`/api/nutrition/day?date=${encodeURIComponent(date)}`);
    if (selectedDate === date) {
      currentDay = day;
      renderDay(day);
      loadReview(day);
    }
    await loadRecentDays();
    toast("Quantity updated.");
  } catch (error) {
    toast(error.message);
    save.disabled = false;
  }
});
$("#food-form").addEventListener("submit", submitFood);
$("#food-input").addEventListener("input", resizeComposer);
$("#food-input").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#food-form").requestSubmit();
  }
});
$("#food-date").addEventListener("change", event => loadDay(event.target.value));
$("#macro-list").addEventListener("click", event => {
  const control = event.target.closest("[data-nutrient]");
  if (control) showNutrientContributors(control.dataset.nutrient);
});
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