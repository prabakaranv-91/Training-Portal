const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/assistant.js"), "utf8");
const context = vm.createContext({ Date });
vm.runInContext(source.slice(source.indexOf("function localDate("), source.indexOf("\nfunction escapeHtml(")), context);
vm.runInContext(source.slice(source.indexOf("function nutritionGoalStatus("), source.indexOf("\nfunction renderRecentDays(")), context);
const targets = { kcal: 2000, protein: 120, carbs: 250, fat: 60, fiber: 30, sugar: 50, sodium: 2300 };
const now = new Date(2026, 9, 9, 9);

test("the complete conversation script has valid syntax", () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test("each logged portion has an editable seven-nutrient form without changing quantities", () => {
  const renderer = vm.createContext({ escapeHtml: value => String(value ?? ""), number: value => Math.round(value || 0) });
  vm.runInContext(source.slice(source.indexOf("function renderFoodPanel("), source.indexOf("\nfunction renderEntry(")), renderer);
  const food = { name: "Bowl", qty: 3, unit: "bowl", protein: 126, kcal: 1800 };
  const portions = [{ entryId: "first", index: 0, time: "12:30", item: { name: "Bowl", qty: 1, unit: "bowl", protein: 42, kcal: 600 } }, { entryId: "second", index: 1, time: "19:00", item: { name: "Bowl", qty: 2, unit: "bowl", protein: 84, kcal: 1200 } }];
  const rendered = renderer.renderFoodPanel(food, portions);
  assert.equal((rendered.match(/class="food-nutrition-form"/g) || []).length, 2);
  for (const nutrient of ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium"]) {
    assert.equal((rendered.match(new RegExp(`name="${nutrient}"`, "g")) || []).length, 2);
  }
  assert.match(rendered, /name="protein"[^>]*value="42"/);
  assert.match(rendered, /name="protein"[^>]*value="84"/);
  assert.match(rendered, /data-id="first" data-item="0"/);
  assert.match(rendered, /data-id="second" data-item="1"/);
  assert.match(rendered, /data-action="cancel-nutrition"/);
  assert.match(rendered, /Edit protein for Bowl/);
  assert.match(rendered, /class="food-nutrition-line"/);
  assert.match(rendered, /class="food-edit-nutrition-icon"[^>]*aria-label="Edit nutrition of Bowl"/);
  assert.match(rendered, /data-lucide="pencil"/);
  assert.doesNotMatch(rendered, />Edit nutrition<\/button>/);
  assert.equal(portions[0].item.qty, 1);
  assert.equal(portions[1].item.qty, 2);
  const readonly = renderer.renderFoodPanel(food, []);
  assert.equal((readonly.match(/class="food-nutrition-form"/g) || []).length, 0);
});
test("the calendar icon opens the native picker and preserves Safari fallback", () => {
  let opened = 0;
  let prevented = 0;
  const input = { showPicker: () => { opened++; } };
  const event = { preventDefault: () => { prevented++; } };
  const picker = vm.createContext({ $: () => input });
  vm.runInContext(source.slice(source.indexOf("function openDatePicker("), source.indexOf("\nwindow.lucide")), picker);
  assert.equal(picker.openDatePicker(event), true);
  assert.equal(opened, 1);
  assert.equal(prevented, 1);
  delete input.showPicker;
  assert.equal(picker.openDatePicker(event), false);
  assert.equal(prevented, 1);
  input.showPicker = () => { throw new Error("Native activation required"); };
  assert.equal(picker.openDatePicker(event), false);
  assert.equal(prevented, 1);
});

test("activity filters expand on demand without resetting selections", () => {
  const dashboardSource = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
  const attributes = new Map();
  const controls = { "activity-filters": { hidden: true }, "activity-filter": { value: "running" }, "activity-filter-toggle": { setAttribute: (name, value) => attributes.set(name, value) } };
  const filters = vm.createContext({ document: { getElementById: id => controls[id] } });
  vm.runInContext(dashboardSource.slice(dashboardSource.indexOf("function setActivityFiltersOpen("), dashboardSource.indexOf('\ndocument.getElementById("activity-filter-toggle").addEventListener')), filters);
  filters.setActivityFiltersOpen(true);
  assert.equal(controls["activity-filters"].hidden, false);
  assert.equal(attributes.get("aria-expanded"), "true");
  filters.setActivityFiltersOpen(false);
  assert.equal(controls["activity-filters"].hidden, true);
  assert.equal(controls["activity-filter"].value, "running");
});

test("mobile navigation isolates the chat and closing restores it", () => {
  const attributes = new Map();
  const classes = new Map();
  const media = { matches: true };
  const control = () => ({ hidden: true, inert: false, focus() {}, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name), classList: { toggle: (name, value) => classes.set(name, value) } });
  const controls = Object.fromEntries([".food-shell", "#food-sidebar", "#sidebar-open", "#sidebar-toggle", "#sidebar-backdrop", ".food-main", "#insight-rail"].map(selector => [selector, control()]));
  const drawer = vm.createContext({ $: selector => controls[selector], window: { matchMedia: () => media }, document: { body: control() } });
  vm.runInContext(source.slice(source.indexOf("function setSidebarCollapsed("), source.indexOf('\n$("#sidebar-toggle").addEventListener')), drawer);
  drawer.setSidebarCollapsed(false);
  assert.equal(controls["#food-sidebar"].hidden, false);
  assert.equal(controls["#sidebar-backdrop"].hidden, false);
  assert.equal(controls[".food-main"].inert, true);
  assert.equal(attributes.get("aria-modal"), "true");
  drawer.setSidebarCollapsed(true);
  assert.equal(controls["#food-sidebar"].hidden, true);
  assert.equal(controls["#sidebar-backdrop"].hidden, true);
  assert.equal(controls[".food-main"].inert, false);
  assert.equal(attributes.has("aria-modal"), false);
  media.matches = false;
  drawer.setSidebarCollapsed(false);
  assert.equal(controls["#sidebar-backdrop"].hidden, true);
  assert.equal(controls["#sidebar-open"].hidden, true);
  assert.equal(controls[".food-main"].inert, false);
});

test("closing the dashboard menu hides its options and resets the toggle", () => {
  const dashboardSource = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
  const removed = [];
  const attributes = new Map();
  const menu = { classList: { remove: name => removed.push(name) } };
  const toggle = { setAttribute: (name, value) => attributes.set(name, value) };
  const dashboard = vm.createContext({ document: { getElementById: id => id === "dashboard-nav" ? menu : toggle } });
  vm.runInContext(dashboardSource.slice(dashboardSource.indexOf("function closeDashboardMenu("), dashboardSource.indexOf("\nwindow.lucide")), dashboard);
  dashboard.closeDashboardMenu();
  assert.deepEqual(removed, ["is-open"]);
  assert.equal(attributes.get("aria-expanded"), "false");
});

test("shared settings offers either missing provider and disables connected providers", () => {
  const setupSource = fs.readFileSync(path.join(__dirname, "../frontend/setup.js"), "utf8");
  const list = { innerHTML: "" };
  const settings = vm.createContext({ setupBusy: false, document: { getElementById: () => list } });
  vm.runInContext(setupSource.slice(setupSource.indexOf("function renderConnectedApps("), setupSource.indexOf("\nfunction resetSetupGarmin(")), settings);
  for (const garmin of [false, true]) {
    for (const strava of [false, true]) {
      settings.setupState = { garmin: { ready: garmin }, strava: { ready: strava, configured: true } };
      settings.renderConnectedApps();
      const garminButton = list.innerHTML.match(/<button[^>]*data-connect-provider="garmin"[^>]*>/)[0];
      const stravaButton = list.innerHTML.match(/<button[^>]*data-connect-provider="strava"[^>]*>/)[0];
      assert.equal(garminButton.includes("disabled"), garmin);
      assert.equal(stravaButton.includes("disabled"), strava);
    }
  }
  settings.setupState = { garmin: { ready: false }, strava: { ready: false, configured: false } };
  settings.renderConnectedApps();
  assert.match(list.innerHTML, /Not configured/);
  assert.match(list.innerHTML, /data-connect-provider="strava" disabled/);
  settings.setupBusy = true;
  settings.renderConnectedApps();
  assert.match(list.innerHTML, /data-connect-provider="garmin" disabled/);
});

test("dashboard Strava consent links to Garmin only when Garmin is authenticated", () => {
  const dashboardSource = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
  const dashboard = vm.createContext({ stravaConnected: false, garminConnected: true, window: { location: { href: "" } } });
  vm.runInContext(dashboardSource.slice(dashboardSource.indexOf("function onStravaButton("), dashboardSource.indexOf("\n// ----------------------------------------------------------- vo2 modal")), dashboard);
  dashboard.onStravaButton();
  assert.equal(dashboard.window.location.href, "/api/strava/connect?link=1");
  dashboard.garminConnected = false;
  dashboard.onStravaButton();
  assert.equal(dashboard.window.location.href, "/api/strava/connect");
});

function day(date, changes = {}) {
  return { date, targets: { ...targets }, intake: { ...targets, sugar: 20, sodium: 1500, ...changes } };
}

test("chat renders meals chronologically without changing sheet entry order", () => {
  const entries = [{ id: "tiramisu", time: "16:13" }, { id: "eggs", time: "19:01" }, { id: "rice", time: "15:15" }, { id: "curd", time: "19:02" }, { id: "morning", time: "9:00" }, { id: "same-time", time: "19:01" }, { id: "unknown" }];
  const original = entries.map(entry => entry.id);
  const rendered = [];
  const conversation = { innerHTML: "", scrollHeight: 0 };
  const renderer = vm.createContext({ renderBalance() {}, renderRecentDays() {}, friendlyDate: value => value, escapeHtml: value => value, renderEntry: entry => { rendered.push(entry.id); return ""; }, foodDetailsVisible: false, contributorsNutrient: null });
  renderer.$ = () => conversation;
  vm.runInContext(source.slice(source.indexOf("function renderDay("), source.indexOf("\nfunction renderFoodRating(")), renderer);
  renderer.renderDay({ date: "2026-10-09", entries });
  assert.deepEqual(rendered, ["morning", "rice", "tiramisu", "eggs", "same-time", "curd", "unknown"]);
  assert.deepEqual(entries.map(entry => entry.id), original);
});

test("completed days assess all nutrients, not calories alone", () => {
  assert.equal(context.nutritionGoalStatus(day("2026-10-08"), now).state, "met");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { protein: 90 }), now).state, "near");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { protein: 30 }), now).state, "off");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { sodium: 3000 }), now).state, "off");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { sugar: 70 }), now).state, "off");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { protein: 150, fiber: 40 }), now).state, "met");
});

test("today is time-aware rather than grading early shortfalls as missed goals", () => {
  const low = day("2026-10-09", { kcal: 200, protein: 10, carbs: 25, fat: 6, fiber: 3 });
  const morning = context.nutritionGoalStatus(low, now);
  assert.equal(morning.state, "progress");
  assert.match(morning.detail, /15h 0m left today/);
  assert.equal(context.nutritionGoalStatus(low, new Date(2026, 9, 9, 22)).state, "near");
  assert.equal(context.nutritionGoalStatus(day("2026-10-09", { kcal: 3000 }), now).state, "off");
});

test("normal nutrition variation remains green without hiding major differences", () => {
  const varied = day("2026-10-08", { kcal: 2300, protein: 100, carbs: 280, fat: 68, fiber: 25, sugar: 52, sodium: 2400 });
  const result = context.nutritionGoalStatus(varied, now);
  assert.equal(result.state, "met");
  assert.match(result.detail, /normal variation/);
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { kcal: 2600 }), now).state, "near");
  assert.equal(context.nutritionGoalStatus(day("2026-10-08", { kcal: 3000 }), now).state, "off");
});

test("missing nutrient targets cannot be shown as fully achieved", () => {
  const partial = day("2026-10-08");
  partial.targets = { kcal: 2000 };
  const result = context.nutritionGoalStatus(partial, now);
  assert.equal(result.state, "unknown");
  assert.match(result.detail, /Protein, Carbs, Fat, Fibre, Sugar, Sodium/);
  assert.match(result.detail, /Calories: 2,000 \/ 2,000 kcal/);
  const missingIntake = day("2026-10-08", { sugar: null });
  assert.equal(context.nutritionGoalStatus(missingIntake, now).state, "unknown");
});

test("successful settings verification refreshes a blocked chat exactly once", async () => {
  let refreshes = 0;
  const readiness = vm.createContext({ waitingForNutritionSetup: true, initialize: async () => { refreshes++; } });
  vm.runInContext(source.slice(source.indexOf("async function nutritionReadinessChanged("), source.indexOf("\nasync function loadProgram(")), readiness);
  await readiness.nutritionReadinessChanged({ detail: { ready: false } });
  assert.equal(refreshes, 0);
  await readiness.nutritionReadinessChanged({ detail: { ready: true } });
  await readiness.nutritionReadinessChanged({ detail: { ready: true } });
  assert.equal(refreshes, 1);
  assert.equal(readiness.waitingForNutritionSetup, false);
});

test("day refresh finishes without waiting for the optional AI review", async () => {
  const controls = new Map();
  const getControl = selector => {
    if (!controls.has(selector)) controls.set(selector, { setAttribute() {}, querySelector: () => ({ textContent: "" }), innerHTML: "", value: "" });
    return controls.get(selector);
  };
  let finishReview;
  const review = new Promise(resolve => { finishReview = resolve; });
  const refresh = vm.createContext({ today: "2026-10-09", busy: false, redirectingToLogin: false, document: { querySelectorAll: () => [] }, friendlyDate: value => value, api: async () => ({ date: "2026-10-09" }), renderDay() {}, loadReview: () => review, showError: error => { throw new Error(error); } });
  refresh.$ = getControl;
  vm.runInContext(source.slice(source.indexOf("async function loadDay("), source.indexOf("\nfunction renderDay(")), refresh);
  let finished = false;
  const pending = refresh.loadDay("2026-10-09").then(() => { finished = true; });
  await new Promise(setImmediate);
  try {
    assert.equal(finished, true);
    assert.equal(getControl("#send-btn").disabled, false);
  } finally {
    finishReview();
    await pending;
  }
});

test("deletion keeps the conversation visible and does not wait for AI review", async () => {
  const classes = new Set();
  const row = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const attributes = new Map();
  const button = { dataset: { action: "remove-entry", id: "meal" }, closest: () => row, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  let finishDay;
  const day = new Promise(resolve => { finishDay = resolve; });
  let rendered = false;
  const requests = [];
  const mutation = vm.createContext({ selectedDate: "2026-10-09", confirm: () => true, api: async path => { requests.push(path); return path.startsWith("/api/nutrition/day") ? day : { status: "revoked" }; }, renderDay: () => { rendered = true; }, loadReview: () => new Promise(() => {}), loadRecentDays: () => { throw new Error("Unnecessary history reload"); }, loadDay: () => { throw new Error("Full-chat loader must not run"); }, toast: error => { throw new Error(error); } });
  vm.runInContext(source.slice(source.indexOf("async function performAction("), source.indexOf("\nfunction resizeComposer(")), mutation);
  const pending = mutation.performAction(button);
  await new Promise(setImmediate);
  assert.equal(button.disabled, true);
  assert.equal(classes.has("mutation-pending"), true);
  assert.equal(rendered, false);
  finishDay({ date: "2026-10-09" });
  await pending;
  assert.equal(rendered, true);
  assert.equal(classes.has("mutation-pending"), false);
  assert.equal(attributes.has("aria-busy"), false);
  assert.equal(requests.length, 2);
});

test("failed deletion clears pending feedback and permits retry", async () => {
  const classes = new Set();
  const row = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const button = { dataset: { action: "remove-entry", id: "meal" }, closest: () => row, setAttribute() {}, removeAttribute() {} };
  let message;
  const mutation = vm.createContext({ selectedDate: "2026-10-09", confirm: () => true, api: async () => { throw new Error("Sheet unavailable"); }, toast: value => { message = value; } });
  vm.runInContext(source.slice(source.indexOf("async function performAction("), source.indexOf("\nfunction resizeComposer(")), mutation);
  await mutation.performAction(button);
  assert.equal(button.disabled, false);
  assert.equal(classes.has("mutation-pending"), false);
  assert.equal(message, "Sheet unavailable");
});

test("meal submission unlocks without reloading full history", async () => {
  const input = { value: "1 banana", focus() {} };
  const send = { disabled: false };
  const conversation = { append() {}, scrollHeight: 0 };
  const requests = [];
  const submission = vm.createContext({ busy: false, selectedDate: "2026-10-09", document: { createElement: () => ({ remove() {} }) }, escapeHtml: value => value, resizeComposer() {}, api: async path => { requests.push(path); return { entry: { id: "saved-entry" } }; }, insertSavedEntry() {}, refreshSavedMeal: () => new Promise(() => {}), loadRecentDays: () => { throw new Error("Unnecessary history reload"); }, toast: error => { throw new Error(error); } });
  submission.$ = selector => ({ "#food-input": input, "#send-btn": send, "#conversation": conversation })[selector];
  vm.runInContext(source.slice(source.indexOf("async function submitFood("), source.indexOf("\nasync function performAction(")), submission);
  await submission.submitFood({ preventDefault() {} });
  assert.equal(submission.busy, false);
  assert.equal(send.disabled, false);
  assert.deepEqual(requests, ["/api/nutrition/log?include_day=false"]);
});

test("failed totals refresh does not turn a confirmed save into a failed meal", async () => {
  let message;
  const refresh = vm.createContext({ selectedDate: "2026-10-09", savedMealRefresh: 0, busy: false, api: async () => { throw new Error("Sheet unavailable"); }, toast: value => { message = value; } });
  vm.runInContext(source.slice(source.indexOf("async function refreshSavedMeal("), source.indexOf("\nasync function submitFood(")), refresh);
  await refresh.refreshSavedMeal("2026-10-09");
  assert.match(message, /^Meal saved\. Daily totals could not refresh/);
});

test("older background totals cannot overwrite a newer saved meal", async () => {
  const responses = [];
  const rendered = [];
  const refresh = vm.createContext({ selectedDate: "2026-10-09", savedMealRefresh: 0, busy: false, api: () => new Promise(resolve => responses.push(resolve)), renderDay: day => rendered.push(day.id), loadReview: async () => {}, toast: error => { throw new Error(error); } });
  vm.runInContext(source.slice(source.indexOf("async function refreshSavedMeal("), source.indexOf("\nasync function submitFood(")), refresh);
  const first = refresh.refreshSavedMeal("2026-10-09");
  const second = refresh.refreshSavedMeal("2026-10-09");
  responses[1]({ id: "newer" });
  await second;
  responses[0]({ id: "older" });
  await first;
  assert.deepEqual(rendered, ["newer"]);
});

test("confirmed meals are inserted by time before totals finish refreshing", () => {
  let insertedBefore;
  const saved = { dataset: { time: "16:30" } };
  const threads = ["15:15", "16:13", "19:01", "19:02"].map(time => ({ dataset: { time }, before: node => { assert.equal(node, saved); insertedBefore = time; } }));
  threads.push(saved);
  const insertion = vm.createContext({ renderEntry: () => "confirmed entry" });
  insertion.$ = () => ({ querySelectorAll: () => threads, querySelector: () => null });
  vm.runInContext(source.slice(source.indexOf("function insertSavedEntry("), source.indexOf("\nasync function refreshSavedMeal(")), insertion);
  insertion.insertSavedEntry({ insertAdjacentHTML() {}, previousElementSibling: saved, remove() {} }, { time: "16:30" });
  assert.equal(insertedBefore, "19:01");
});

test("overlapping refreshes do not duplicate an already displayed confirmed meal", () => {
  const insertion = vm.createContext({ renderEntry: () => { throw new Error("Confirmed meal must not be duplicated"); } });
  insertion.$ = () => ({ querySelectorAll: () => [{ dataset: { entry: "saved-entry" } }] });
  vm.runInContext(source.slice(source.indexOf("function insertSavedEntry("), source.indexOf("\nasync function refreshSavedMeal(")), insertion);
  let removed = false;
  insertion.insertSavedEntry({ remove: () => { removed = true; } }, { id: "saved-entry", time: "16:30" });
  assert.equal(removed, true);
});