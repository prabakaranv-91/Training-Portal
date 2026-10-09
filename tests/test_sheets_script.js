const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function scriptContext() {
  const tables = new Map();
  const spreadsheet = {
    getSheetByName: name => tables.get(name),
    getSpreadsheetTimeZone: () => "UTC",
    insertSheet(name) {
      const values = [];
      const table = {
        getLastRow: () => values.length,
        setFrozenRows() {},
        deleteRow: row => values.splice(row - 1, 1),
        appendRow: row => values.push([...row]),
        getDataRange: () => ({ getValues: () => values.map(row => [...row]) }),
        getRange(row, column, height, width) {
          return {
            getValues: () => Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_, index) => values[row + offset - 1]?.[column + index - 1] ?? "")),
            getDisplayValues: () => Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_, index) => String(values[row + offset - 1]?.[column + index - 1] ?? ""))),
            setValues(rows) {
              rows.forEach((cells, offset) => {
                values[row + offset - 1] ||= [];
                cells.forEach((value, index) => { values[row + offset - 1][column + index - 1] = value; });
              });
            },
          };
        },
      };
      tables.set(name, table);
      return table;
    },
  };
  const context = vm.createContext({ Date, SpreadsheetApp: { getActive: () => spreadsheet }, Utilities: { formatDate: (date, zone, format) => format === "HH:mm" ? date.toISOString().slice(11, 16) : date.toISOString().slice(0, 10) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../backend/apps_script/Code.gs"), "utf8"), context);
  return { context, spreadsheet };
}

test("sheet entries round-trip, reflect cell edits, and retain removed items", () => {
  const { context, spreadsheet } = scriptContext();
  const entry = { id: "meal", date: "2026-10-09", time: "08:00", text: "iso whey and egg", items: [
    { name: "Whey isolate", input: "iso whey", qty: 1, unit: "scoop", grams: 30, protein: 27, kcal: 115, found: true, source: "AI", nutrition_basis: "label" },
    { name: "Egg", qty: 1, unit: "piece", grams: 50, protein: 6, kcal: 72, found: true, source: "Table", revoked: true },
  ] };
  context.upsertEntry("Example", entry);
  let stored = context.getNutrition("Example").entries[0];
  assert.equal(stored.items[0].protein, 27);
  assert.equal(stored.items[0].nutrition_basis, "label");
  assert.equal(stored.items[1].revoked, true);
  assert.equal(stored.totals.protein, 27);
  const table = spreadsheet.getSheetByName("Example \u00b7 Entries");
  table.getRange(2, 12, 1, 1).setValues([[28]]);
  stored = context.getNutrition("Example").entries[0];
  assert.equal(stored.totals.protein, 28);
  assert.equal(context.getNutrition("Other").entries.length, 0);
});

test("idempotent updates and empty entries remain in the sheet", () => {
  const { context, spreadsheet } = scriptContext();
  const entry = { id: "meal", date: "2026-10-09", time: "08:00", text: "unknown food", items: [] };
  context.upsertEntry("Example", entry);
  context.upsertEntry("Example", entry);
  assert.equal(spreadsheet.getSheetByName("Example \u00b7 Entries").getLastRow(), 2);
  const stored = context.getNutrition("Example").entries;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "unknown food");
  assert.equal(stored[0].items.length, 0);
});

test("day targets, programs, weights, and reviews round-trip without local storage", () => {
  const { context } = scriptContext();
  const date = "2026-10-09";
  context.upsertDay("Example", date, { intake: { kcal: 115, protein: 27 }, targets: { kcal: 1800, protein: 150 }, burn: { total: 2200, source: "garmin" }, status: "low", weightKg: 72, program: "loss" });
  context.upsertProgram("Example", { from: date, program: "loss", label: "Weight loss", setAt: date });
  context.upsertWeight("Example", { date, kg: 72, setAt: date, source: "garmin" });
  context.upsertReview("Example", date, "signature", { verdict: "under", summary: "Review", avoid: [], keep: [], next: "Next", add: [] });
  const data = context.getNutrition("Example");
  assert.equal(data.days[date].targets.protein, 150);
  assert.equal(data.days[date].intake.protein, 27);
  assert.equal(data.programs[0].program, "loss");
  assert.equal(data.weights[0].source, "garmin");
  assert.equal(data.coach[date].sig, "signature");
  assert.equal(data.coach[date].review.summary, "Review");
});