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
  high: { label: "Exceeds", cls: "high" },
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
  loadNutritionCoach(day);
  const label = day.inProgress
    ? "Today"
    : new Date(`${day.date}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  document.getElementById("nutri-chat-sub").textContent =
    `${label} · ${nutriFmt(day.intake.kcal)} / ${nutriFmt(day.targets.kcal)} kcal`;
}

let nutriCoachSeq = 0;
const NUTRI_VERDICT = {
  on_track: { label: "On track", cls: "ok" },
  over: { label: "Over target", cls: "high" },
  under: { label: "Under target", cls: "low" },
};

// The day review is generated once by Gemini and stored (sheet + local); "Update" regenerates it on demand.
async function loadNutritionCoach(day, refresh = false) {
  const seq = ++nutriCoachSeq;
  if (!document.getElementById("nutri-coach")) return;
  let review = null;
  try {
    review = await api(`/api/nutrition/coach?date=${encodeURIComponent(day.date)}${refresh ? "&refresh=true" : ""}`);
  } catch (_) {}
  const el = document.getElementById("nutri-coach");
  if (seq !== nutriCoachSeq || !el) return;
  if (review && review.source === "gemini" && review.from === "gemini" && nutriApplyReview(day, review)) {
    // A fresh review changed some food ratings: redraw the chips, keeping this review bubble.
    renderNutritionMessages(day);
  }
  const target = document.getElementById("nutri-coach");
  if (!target) return;
  nutriFillCoach(target, day, review);
  const box = document.getElementById("nutri-messages");
  box.scrollTop = box.scrollHeight;
}

function nutriApplyReview(day, review) {
  const match = (a, b) => a.includes(b) || b.includes(a);
  let changed = false;
  for (const e of day.entries) {
    for (const i of e.items) {
      const name = (i.name || "").toLowerCase();
      const bad = (review.avoid || []).find((a) => match(name, a.item.toLowerCase()));
      const good = !bad && (review.keep || []).find((k) => match(name, k.toLowerCase()));
      const rating = bad ? "avoid" : good && i.rating !== "best" ? "best" : i.rating;
      if (rating !== i.rating) {
        i.rating = rating;
        i.ratingWhy = bad
          ? `${bad.reason}. Try ${bad.instead} instead (from today's review).`
          : `Today's review says this helps your goal (${Math.round(i.protein || 0)} g protein, ${Math.round(i.kcal || 0)} kcal). Keep it up!`;
        changed = true;
      }
    }
  }
  return changed;
}

function nutriFillCoach(el, day, review) {
  if (!review || review.source !== "gemini") {
    const tips = day.cutTips || [];
    if (!tips.length) return el.remove();
    el.classList.add("nutri-tip");
    el.innerHTML = tips.map((t) => `<div>${escapeAttr(t)}</div>`).join("");
  } else {
    const v = NUTRI_VERDICT[review.verdict] || NUTRI_VERDICT.on_track;
    const avoid = (review.avoid || [])
      .map((a) => `<li><b>${escapeAttr(a.item)}</b> — ${escapeAttr(a.reason)}<span class="dim"> → ${escapeAttr(a.instead)}</span></li>`)
      .join("");
    el.innerHTML = `
      <div class="nc-head">🤖 <b>Day review</b> <span class="nutri-status ${v.cls}">${v.label}</span>
        ${review.stale ? `<span class="dim nc-stale" title="You logged food after this review">outdated</span>
        <button class="nutri-act nutri-review-refresh" title="Review the day again with Gemini (uses 1 request)">↻ Update</button>` : ""}</div>
      ${review.summary ? `<div>${escapeAttr(review.summary)}</div>` : ""}
      ${avoid ? `<div class="nc-sec">🚫 Avoid</div><ul>${avoid}</ul>` : ""}
      ${(review.keep || []).length ? `<div class="nc-sec">👍 Keep: <span>${review.keep.map(escapeAttr).join(", ")}</span></div>` : ""}
      ${(review.add || []).length ? `<div class="nc-sec">🍛 Eat next</div><ul>${review.add
        .map((a) => `<li><b>${escapeAttr(a.food)}</b> · ${escapeAttr(a.portion)}<span class="dim"> — ${escapeAttr(a.why)}</span></li>`)
        .join("")}</ul>` : ""}
      ${review.next ? `<div class="dim nc-next">💡 ${escapeAttr(review.next)}</div>` : ""}`;
  }
  const box = document.getElementById("nutri-messages");
  box.scrollTop = box.scrollHeight;
}

function renderNutritionMessages(day) {
  const box = document.getElementById("nutri-messages");
  if (!day.entries.length) {
    box.innerHTML = `<div class="nutri-bot dim nutri-hint-empty">Tell me what you ate — e.g. "2 idli with 1 cup sambar", "1 scoop iso whey".</div>`;
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
          return `<span class="nutri-chip${i.revoked ? " revoked" : ""}" title="${escapeAttr(tip)}">${i.revoked ? "" : nutriRateIcon(i)}${escapeAttr(i.name)}
            ${i.revoked ? `×${i.qty}` : `<button class="nutri-qty" data-id="${id}" data-item="${idx}" data-qty="${i.qty}" title="Edit quantity (${escapeAttr(i.unit)})">×${i.qty} ✎</button>`}
            <b>${nutriFmt(i.kcal)}</b>${act}</span>`;
        })
        .join("");
      return `
        <div class="nutri-user">${escapeAttr(e.text)}</div>
        <div class="nutri-bot">${items}<span class="nutri-total">= ${nutriFmt(e.totals.kcal)} kcal</span>
          <button class="nutri-act nutri-revoke" data-id="${id}" title="Remove entry">🗑</button>
          ${nutriFoodTable(e.items, `e-${e.id}`)}</div>`;
    })
    .join("");
  if (day.entries.some((e) => !e.revoked)) {
    box.innerHTML += `<div id="nutri-coach" class="nutri-bot nutri-coach">
      <div class="nutri-typing"><span></span><span></span><span></span><small class="dim">Reviewing your day…</small></div></div>`;
  }
  box.scrollTop = box.scrollHeight;
}

const nutriOpen = new Set(); // keeps expanded nutrient tables open across re-renders

const NUTRI_RATING = {
  best: { icon: "★", title: "Highly recommended — keep eating this" },
  good: { icon: "✔", title: "Good choice for your goal" },
  avoid: { icon: "⊘", title: "Better to avoid" },
};

// ★ highly recommended, ✔ good, ⊘ avoid; neutral foods get no marker. Hover/tap shows why.
function nutriRateIcon(i) {
  const r = NUTRI_RATING[i.rating];
  if (!r) return "";
  return `<span class="nr ${i.rating}" tabindex="0" role="img" aria-label="${escapeAttr(`${r.title}. ${i.ratingWhy || ""}`)}"
    data-tip-title="${escapeAttr(r.title)}" data-tip="${escapeAttr(i.ratingWhy || "")}">${r.icon}</span>`;
}

function nutriShowTip(el) {
  let pop = document.getElementById("nutri-tip-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "nutri-tip-pop";
    pop.className = "nutri-tip-pop";
    document.body.appendChild(pop);
  }
  const kind = [...el.classList].find((c) => NUTRI_RATING[c]) || "";
  pop.className = `nutri-tip-pop ${kind}`;
  pop.innerHTML = `<b>${el.textContent} ${escapeAttr(el.dataset.tipTitle)}</b><div>${escapeAttr(el.dataset.tip)}</div>`;
  pop.style.display = "block";
  const r = el.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function nutriHideTip() {
  const pop = document.getElementById("nutri-tip-pop");
  if (pop) pop.style.display = "none";
}

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.(".nr[data-tip]");
  if (el) nutriShowTip(el);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest?.(".nr[data-tip]")) nutriHideTip();
});
document.addEventListener("focusin", (e) => {
  if (e.target.matches?.(".nr[data-tip]")) nutriShowTip(e.target);
});
document.addEventListener("focusout", nutriHideTip);
document.addEventListener("scroll", nutriHideTip, true);

function nutriNum(v) {
  if (v == null) return "–";
  return Math.abs(v) < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toLocaleString();
}

function nutriFoodTable(items, key) {
  const rows = items
    .filter((i) => i.found !== false && !i.revoked)
    .map(
      (i) => `<tr><td>${nutriRateIcon(i)}${escapeAttr(i.name)} <small class="dim">${i.qty} ${escapeAttr(i.unit)}${i.grams ? ` · ${nutriFmt(i.grams)} g` : ""}</small></td>
        <td>${nutriFmt(i.kcal)}</td>${NUTRI_ROWS.map((r) => `<td>${nutriNum(i[r.key])}</td>`).join("")}</tr>`
    )
    .join("");
  if (!rows) return "";
  return `<details class="nutri-details" data-key="${escapeAttr(key)}"${nutriOpen.has(key) ? " open" : ""}>
    <summary>Nutrients per food</summary>
    <table class="nutri-items nutri-food">
      <thead><tr><th>Food</th><th>kcal</th>${NUTRI_ROWS.map((r) => `<th>${r.label} <small>${r.unit}</small></th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></details>`;
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
  const rows = [{ key: "kcal", label: "Calories", unit: "kcal" }, ...NUTRI_ROWS];
  el.innerHTML = `
    <table class="nutri-table">
      <thead><tr><th><span class="nutri-status ${st.cls}" title="${escapeAttr(tips)}">${st.label}${tips ? " ⓘ" : ""}</span>
        <small class="nutri-prog">${escapeAttr(day.programLabel || "")} · ${day.weightKg} kg${day.weightSource === "default" ? "?" : ""}</small></th>
        <th>Today</th><th>Target</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr><td>${r.label} <small>${r.unit}</small></td>${cell(r.key)}
              <td class="dim">${r.limit ? "≤" : ""}${nutriFmt(targets[r.key])}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
    ${nutriCutsHtml(day)}`;
}

function nutriCutsHtml(day) {
  const cuts = day.cuts || [];
  if (!cuts.length) return "";
  const lines = cuts
    .map((c) => {
      const what = c.cut >= c.of ? `Skip ${escapeAttr(c.name)}` : `−${c.cut} ${escapeAttr(c.name)}`;
      return `<li title="${escapeAttr(c.swap ? `Swap for ${c.swap}` : "")}">${what} <b>−${nutriFmt(c.kcal)}</b></li>`;
    })
    .join("");
  return `<div class="nutri-cuts"><div class="dim">✂️ To hit your target</div><ul>${lines}</ul></div>`;
}

let nutriBusy = false;

function setNutritionBusy(busy) {
  nutriBusy = busy;
  const input = document.getElementById("nutri-input");
  const btn = document.getElementById("nutri-send");
  input.disabled = busy;
  btn.disabled = busy;
  btn.textContent = busy ? "…" : "Log";
  document.getElementById("nutri-chatbox").classList.toggle("busy", busy);
}

async function submitNutrition(e) {
  e.preventDefault();
  if (nutriBusy) return;
  const input = document.getElementById("nutri-input");
  const text = input.value.trim();
  if (!text) return;
  const box = document.getElementById("nutri-messages");
  box.querySelector(".nutri-hint-empty")?.remove();
  // Show the message right away with a typing indicator while it's analysed.
  const pending = document.createElement("div");
  pending.className = "nutri-pending";
  pending.innerHTML = `<div class="nutri-user">${escapeAttr(text)}</div>
    <div class="nutri-bot nutri-typing" aria-label="Analysing"><span></span><span></span><span></span>
      <small class="dim">Analysing your meal…</small></div>`;
  box.appendChild(pending);
  box.scrollTop = box.scrollHeight;
  input.value = "";
  setNutritionBusy(true);
  try {
    const res = await api("/api/nutrition/log", {
      method: "POST",
      body: JSON.stringify({ text, date: document.getElementById("nutri-date").value || null }),
    });
    renderNutritionDay(res.day);
  } catch (ex) {
    pending.remove();
    input.value = text;
    toast(`Could not log meal: ${ex.message}`);
  } finally {
    setNutritionBusy(false);
    input.focus();
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

function editNutritionQty(btn) {
  const { id, item, qty } = btn.dataset;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0.25";
  input.step = "0.5";
  input.value = qty;
  input.className = "nutri-qty-input";
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = parseFloat(input.value);
    if (!save || !(val > 0) || val === parseFloat(qty)) {
      loadNutrition();
      return;
    }
    try {
      await api(`/api/nutrition/entries/${encodeURIComponent(id)}/items/${encodeURIComponent(item)}`, {
        method: "PATCH",
        body: JSON.stringify({ qty: val }),
      });
    } catch (ex) {
      toast(`Could not update quantity: ${ex.message}`);
    }
    loadNutrition();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// ------------------------------------------------------------- history

async function openNutritionHistory() {
  document.getElementById("nutri-history-modal").classList.remove("hidden");
  document
    .querySelectorAll("#nutri-history-periods button")
    .forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === nutriHistoryDays));
  api("/api/nutrition/program").then(renderNutritionProgram).catch(() => {});
  api("/api/nutrition/weight").then(renderNutritionWeight).catch(() => {});
  try {
    const { days, progress } = await api(`/api/nutrition/history?days=${nutriHistoryDays}`);
    renderNutritionProgress(progress);
    renderNutritionHistory(days);
  } catch (ex) {
    document.getElementById("nutri-history-table").innerHTML =
      `<div class="empty">Could not load history: ${escapeAttr(ex.message)}</div>`;
  }
}

const NUTRI_PROGRAM_LABEL = {}; // filled from /api/nutrition/program

function renderNutritionProgram(p) {
  const select = document.getElementById("nutri-program");
  const opts = p.options || [];
  opts.forEach((o) => (NUTRI_PROGRAM_LABEL[o.key] = o.label));
  if (select.options.length !== opts.length) {
    select.innerHTML = opts.map((o) => `<option value="${escapeAttr(o.key)}">${escapeAttr(o.label)}</option>`).join("");
  }
  select.value = p.current;
  const note = (opts.find((o) => o.key === p.current) || {}).note || "";
  const since = (p.history || []).find((h) => h.program === p.current);
  document.getElementById("nutri-program-note").textContent =
    `${note}${since ? ` · since ${nutriShortDate(since.from)}` : ""}`;
}

function nutriShortDate(s) {
  return new Date(`${s}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function renderNutritionWeight(w) {
  const cur = w.current;
  const fromGarmin = !!w.garminKg;
  const shown = document.getElementById("nutri-weight-garmin");
  shown.classList.toggle("hidden", !fromGarmin);
  shown.textContent = fromGarmin ? `${w.garminKg} kg` : "";
  document.getElementById("nutri-weight-edit").classList.toggle("hidden", fromGarmin);
  document.getElementById("nutri-weight").value = !fromGarmin && cur ? cur.kg : "";
  document.getElementById("nutri-weight-note").textContent = fromGarmin
    ? "Synced from Garmin Connect"
    : cur ? `Last logged ${nutriShortDate(cur.date)}` : "Not in Garmin — enter your weight";
}

async function saveNutritionWeight(e) {
  e.preventDefault();
  const kg = parseFloat(document.getElementById("nutri-weight").value);
  if (!(kg >= 25 && kg <= 350)) {
    toast("Enter a weight between 25 and 350 kg");
    return;
  }
  try {
    renderNutritionWeight(
      await api("/api/nutrition/weight", { method: "POST", body: JSON.stringify({ kg }) })
    );
    toast(`Weight saved: ${kg} kg`);
    loadNutrition();
    openNutritionHistory();
  } catch (ex) {
    toast(`Could not save weight: ${ex.message}`);
  }
}

function nutriSparkline(points) {
  if (points.length < 2) return "";
  const w = 150, h = 34, kg = points.map((p) => p.kg);
  const lo = Math.min(...kg) - 0.3, hi = Math.max(...kg) + 0.3;
  const xy = points.map((p, i) => [
    (i / (points.length - 1)) * w,
    h - ((p.kg - lo) / (hi - lo)) * h,
  ]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];
  return `<svg class="nh-spark" viewBox="-3 -3 ${w + 6} ${h + 6}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="3" fill="currentColor"/></svg>`;
}

function renderNutritionProgress(p) {
  const el = document.getElementById("nutri-progress");
  if (!p || !p.days) {
    el.innerHTML = "";
    return;
  }
  const fmtDate = (s) => new Date(`${s}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  // Calories: average eaten vs average target, as a bar + one plain sentence.
  const eat = p.avgIntakeKcal, tgt = p.avgTargetKcal, diff = eat - tgt;
  const pct = tgt ? Math.min(100, Math.round((eat / tgt) * 100)) : 0;
  const calCls = Math.abs(diff) <= tgt * 0.1 ? "ok" : diff > 0 ? "high" : "low";
  const sentence = Math.abs(diff) <= tgt * 0.1
    ? "Right on your target 👍"
    : `${nutriFmt(Math.abs(diff))} kcal/day ${diff > 0 ? "over" : "under"} target`;
  const calories = `
    <div class="dim">Calories · daily avg (${p.days}d)</div>
    <div class="nh-val">${nutriFmt(eat)} <small class="dim">/ ${nutriFmt(tgt)} kcal</small></div>
    <div class="nutri-bar"><div class="nutri-fill ${calCls}" style="width:${pct}%"></div></div>
    <div class="nh-sentence ${calCls}">${sentence}</div>`;

  // Weight: current value, change since the first weigh-in, and a mini trend line.
  const pts = p.weights || [];
  let weight = `<div class="dim">Weight</div>`;
  if (!pts.length) {
    weight += `<div class="nh-val">–</div><div class="dim">No weigh-ins in this period</div>`;
  } else {
    const change = p.actualKg ?? 0;
    const arrow = change < 0 ? "↓" : change > 0 ? "↑" : "→";
    weight += `<div class="nh-val">${p.toKg} kg</div>
      ${nutriSparkline(pts)}
      <div class="dim">${pts.length > 1 ? `${arrow} ${Math.abs(change)} kg since ${fmtDate(pts[0].date)}` : `Logged ${fmtDate(pts[0].date)} · add more weigh-ins to see a trend`}</div>`;
  }

  const foods = (p.contributors || [])
    .map((c) => `<li title="${escapeAttr(c.swap ? `Try ${c.swap}` : "")}"><span>${escapeAttr(c.name)}</span><b>${nutriFmt(c.kcal)}</b></li>`)
    .join("");

  const adv = p.advice || {};
  const avoid = (adv.avoid || [])
    .map((a) => `<li title="${escapeAttr(a.why)}">🚫 <b>${escapeAttr(a.name)}</b><span class="dim"> → ${escapeAttr(a.instead)}</span></li>`)
    .join("");
  const add = (adv.add || [])
    .map((a) => `<li title="${escapeAttr(a.why)}">➕ <b>${escapeAttr(a.name)}</b><span class="dim"> · ${escapeAttr(a.portion)}</span></li>`)
    .join("");

  el.innerHTML = `
    <div class="nh-tile">${calories}</div>
    <div class="nh-tile nh-weight">${weight}</div>
    ${nutriForecastTile(p.forecast)}
    ${foods ? `<div class="nh-tile"><div class="dim">Top calorie foods</div><ul class="nh-foods">${foods}</ul></div>` : ""}
    ${avoid || add ? `<div class="nh-tile nh-advice"><div class="dim">To hit your target</div>
      ${avoid ? `<ul class="nh-adv">${avoid}</ul>` : ""}${add ? `<ul class="nh-adv">${add}</ul>` : ""}</div>` : ""}`;
}

// Weight you land on if the last few days of eating + training continue, next to the program's own pace.
function nutriForecastTile(f) {
  if (!f) return "";
  const rate = f.actual.perWeekKg;
  const cls = Math.abs(rate) < 0.05 ? "ok" : rate < 0 ? "low" : "high";
  const pace = Math.abs(rate) < 0.05
    ? "Holding steady at this pace"
    : `${rate < 0 ? "↓" : "↑"} ${Math.abs(rate).toFixed(2)} kg/week at this pace`;
  const note = f.lowData
    ? `Based on ${f.basisDays} logged day${f.basisDays === 1 ? "" : "s"} — log more for a reliable trend.`
    : f.tooFast
      ? "Faster than 1 kg/week — consider easing the deficit/surplus."
      : `If you follow the plan: ${f.plan.in4wKg} kg in 4 weeks.`;
  return `<div class="nh-tile nh-forecast">
    <div class="dim">Projected weight</div>
    <div class="nh-val">${f.actual.in4wKg} kg <small class="dim">in 4 weeks</small></div>
    <div class="dim">${f.actual.in12wKg} kg in 12 weeks · now ${f.currentKg} kg</div>
    <div class="nh-sentence ${cls}">${pace}</div>
    <div class="dim nh-fc-note">${escapeAttr(note)}</div>
  </div>`;
}

async function saveNutritionProgram(e) {
  const select = e.target;
  select.disabled = true;
  try {
    renderNutritionProgram(
      await api("/api/nutrition/program", { method: "POST", body: JSON.stringify({ program: select.value }) })
    );
    toast(`Program set to ${select.options[select.selectedIndex].text}`);
    loadNutrition();
    openNutritionHistory();
  } catch (ex) {
    toast(`Could not save program: ${ex.message}`);
  } finally {
    select.disabled = false;
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
        { type: "line", label: "Target kcal", data: days.map((d) => d.targetKcal ?? null), borderColor: "#a78bfa", borderDash: [5, 4], tension: 0.3, spanGaps: true, pointRadius: 2 },
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
      const foods = (d.items || [])
        .map(
          (i) => `<li><span class="nh-f-name">${nutriRateIcon(i)}${escapeAttr(i.name)}</span>
            <span class="nh-f-qty dim">×${i.qty}</span><span class="nh-f-kcal">${nutriFmt(i.kcal)}</span></li>`
        )
        .join("");
      const macro = (k, lbl) => `<span><i>${lbl}</i> ${nutriFmt(d.intake[k])} g</span>`;
      return `
        <div class="nh-day">
          <div class="nh-head">
            <div class="nh-date">${escapeAttr(label)}
              <small class="nutri-prog">${escapeAttr(d.programLabel || NUTRI_PROGRAM_LABEL[d.program] || "")}</small></div>
            <div class="nh-kcal" title="${d.burn?.total ? `Burned ${nutriFmt(d.burn.total)} kcal` : ""}">
              <b>${nutriFmt(d.intake.kcal)}</b><span class="dim">${d.targetKcal ? ` / ${nutriFmt(d.targetKcal)}` : ""} kcal</span>
              ${d.deviationKcal != null ? `<span class="nh-dev ${d.deviationKcal > 0 ? "over" : "under"}" title="Intake vs program target">${d.deviationKcal > 0 ? "+" : ""}${nutriFmt(d.deviationKcal)}</span>` : ""}
            </div>
            ${st ? `<span class="nutri-status ${st.cls}">${st.label}</span>` : ""}
          </div>
          <div class="nh-macros">${macro("protein", "P")}${macro("carbs", "C")}${macro("fat", "F")}${macro("fiber", "Fib")}
            ${d.weightKg ? `<span class="nh-wt">⚖️ ${d.weightKg} kg</span>` : ""}</div>
          ${foods ? `<ul class="nh-food-list">${foods}</ul>` : '<div class="dim nh-empty-day">No items</div>'}
          ${nutriFoodTable(d.items || [], `d-${d.date}`)}
        </div>`;
    })
    .join("");
  document.getElementById("nutri-history-table").innerHTML = `<div class="nutri-history">${list}</div>`;
}

function closeNutritionHistory() {
  document.getElementById("nutri-history-modal").classList.add("hidden");
}

// ------------------------------------------------------------- wiring

document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!d.classList || !d.classList.contains("nutri-details")) return;
    if (d.open) nutriOpen.add(d.dataset.key);
    else nutriOpen.delete(d.dataset.key);
  },
  true
);
function toggleNutritionChat(open) {
  const box = document.getElementById("nutri-chatbox");
  const show = open ?? box.classList.contains("hidden");
  box.classList.toggle("hidden", !show);
  document.getElementById("nutri-fab").classList.toggle("open", show);
  if (show) {
    const msgs = document.getElementById("nutri-messages");
    msgs.scrollTop = msgs.scrollHeight;
    document.getElementById("nutri-input").focus();
  }
}

document.getElementById("nutri-fab").addEventListener("click", () => toggleNutritionChat());
document.getElementById("nutri-chat-close").addEventListener("click", () => toggleNutritionChat(false));
document.getElementById("nutri-form").addEventListener("submit", submitNutrition);
document.getElementById("nutri-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("nutri-form").requestSubmit();
  }
});
document.getElementById("nutri-date").addEventListener("change", loadNutrition);
document.getElementById("nutri-messages").addEventListener("click", (e) => {
  if (nutriBusy) return;
  const qtyBtn = e.target.closest(".nutri-qty");
  if (qtyBtn) {
    editNutritionQty(qtyBtn);
    return;
  }
  const btn = e.target.closest(".nutri-act");
  if (!btn) return;
  if (btn.classList.contains("nutri-review-refresh")) {
    btn.disabled = true;
    btn.textContent = "Reviewing…";
    if (nutriDay) loadNutritionCoach(nutriDay, true);
  } else if (btn.classList.contains("nutri-retry")) reanalyseNutritionEntry(btn.dataset.id);
  else setNutritionRevoked(btn.dataset.id, btn.dataset.item, btn.classList.contains("nutri-revoke"));
});
document.getElementById("nutri-history-btn").addEventListener("click", openNutritionHistory);
document.getElementById("nutri-history-close").addEventListener("click", closeNutritionHistory);
document.getElementById("nutri-history-modal").addEventListener("click", (e) => {
  if (e.target.id === "nutri-history-modal") closeNutritionHistory();
});
document.getElementById("nutri-program").addEventListener("change", saveNutritionProgram);
document.getElementById("nutri-weight-form").addEventListener("submit", saveNutritionWeight);
document.getElementById("nutri-history-periods").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  nutriHistoryDays = Number(b.dataset.days);
  openNutritionHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeNutritionHistory();
    toggleNutritionChat(false);
  }
});
