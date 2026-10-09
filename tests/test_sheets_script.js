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
      const calls = { writes: 0, clears: 0, deletes: 0 };
      const table = {
        calls,
        getLastRow: () => values.length,
        setFrozenRows() {},
        deleteRow: row => { calls.deletes++; values.splice(row - 1, 1); },
        appendRow: row => values.push([...row]),
        getDataRange: () => ({ getValues: () => values.map(row => [...row]) }),
        getRangeList(ranges) {
          return { clearContent() {
            calls.clears++;
            for (const range of ranges) {
              const match = /^A(\d+):U\d+$/.exec(range);
              assert(match, "Only app-owned entry columns may be cleared");
              const row = values[Number(match[1]) - 1];
              for (let column = 0; column < 21; column++) row[column] = "";
            }
          } };
        },
        getRange(row, column, height, width) {
          return {
            getValues: () => Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_, index) => values[row + offset - 1]?.[column + index - 1] ?? "")),
            getDisplayValues: () => Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_, index) => String(values[row + offset - 1]?.[column + index - 1] ?? ""))),
            setValues(rows) {
              calls.writes++;
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

test("multi-item edits overwrite one range without per-row deletions", () => {
  const { context, spreadsheet } = scriptContext();
  const items = Array.from({ length: 100 }, (_, index) => ({ name: `Food ${index}`, qty: 1, unit: "g", grams: 1, kcal: 1, protein: 1, found: true, source: "Test" }));
  const entry = { id: "bulk", date: "2026-10-09", time: "08:00", text: "multi-item meal", items };
  context.upsertEntry("Example", entry);
  const table = spreadsheet.getSheetByName("Example \u00b7 Entries");
  const before = table.calls.writes;
  context.upsertEntry("Example", { ...entry, revoked: true });
  assert.equal(table.calls.writes - before, 1);
  assert.equal(table.calls.clears, 0);
  assert.equal(table.calls.deletes, 0);
  assert.equal(context.getNutrition("Example").entries[0].revoked, true);
  assert.equal(context.getNutrition("Example").entries[0].items.length, 100);
});

test("resized entry batch cleanup preserves unrelated rows and extra columns", () => {
  const { context, spreadsheet } = scriptContext();
  const item = { name: "Food", qty: 1, unit: "g", grams: 1, kcal: 1, protein: 1, found: true, source: "Test" };
  const entry = { id: "edited", date: "2026-10-09", time: "08:00", text: "meal", items: [item, item] };
  context.upsertEntry("Example", entry);
  context.upsertEntry("Example", { ...entry, id: "unrelated", text: "preserve this meal", items: [item] });
  const table = spreadsheet.getSheetByName("Example \u00b7 Entries");
  table.getRange(2, 22, 1, 1).setValues([["preserve extra note"]]);
  context.upsertEntry("Example", { ...entry, items: [item] });
  const entries = context.getNutrition("Example").entries;
  assert.equal(entries.find(row => row.id === "edited").items.length, 1);
  assert.equal(entries.find(row => row.id === "unrelated").text, "preserve this meal");
  assert.equal(table.getRange(2, 22, 1, 1).getValues()[0][0], "preserve extra note");
  assert.equal(table.calls.clears, 1);
  assert.equal(table.calls.deletes, 0);
});

test("conflicting custom headers are not overwritten during an upgrade", () => {
  const { context, spreadsheet } = scriptContext();
  const table = spreadsheet.insertSheet("Example \u00b7 Entries");
  table.getRange(1, 1, 1, 1).setValues([["Custom data"]]);
  table.getRange(2, 1, 1, 1).setValues([["Preserve this"]]);
  assert.throws(() => context.upsertEntry("Example", { id: "meal", items: [] }), /headers conflict/);
  assert.equal(table.getRange(1, 1, 1, 1).getValues()[0][0], "Custom data");
  assert.equal(table.getRange(2, 1, 1, 1).getValues()[0][0], "Preserve this");
});