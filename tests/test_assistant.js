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

function day(date, changes = {}) {
  return { date, targets: { ...targets }, intake: { ...targets, sugar: 20, sodium: 1500, ...changes } };
}

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