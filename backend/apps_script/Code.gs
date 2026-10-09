/**
 * Training Lab — authoritative nutrition storage (Google Apps Script Web App), version 9.
 *
 * Deploy: Extensions ▸ Apps Script ▸ paste your downloaded script ▸
 * Deploy ▸ Manage deployments ▸
 * edit the existing deployment ▸ Version: New version ▸ Deploy (keeps the same URL).
 *
 * v5 adds the per-user "· Reviews" tab so an AI day review is stored once and
 * reused (upsertReview / getReview) instead of spending quota on every page load.
 */

const TOKEN = "PASTE_SHEETS_TOKEN_HERE"; // Your setup download fills this in.
const VERSION = 9;
const ENTRY_HEADERS = ["user","entryId","itemIndex","date","time","text","food","qty","unit","grams",
  "kcal","protein","carbs","fat","fiber","sugar","sodium","source","revoked","updatedAt","entryJson"];
const DAY_HEADERS = ["user","date","intakeKcal","protein","carbs","fat","fiber","sugar","sodium",
  "burnKcal","targetKcal","status","weightKg","updatedAt","program","dayJson"];
const PROGRAM_HEADERS = ["user","from","program","label","setAt","updatedAt"];
const WEIGHT_HEADERS = ["user","date","kg","setAt","updatedAt","source"];
const REVIEW_HEADERS = ["user","date","reviewed","sig","verdict","summary","avoid","keep","next","json","updatedAt"];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json({ ok: false, error: "unauthorized" });
  if (body.action === "info") {
    return json({ ok: true, version: VERSION,
      sheets: SpreadsheetApp.getActive().getSheets().map((s) => s.getName()) });
  }
  const user = String(body.user || "default").replace(/[\[\]*?\/\\:]/g, " ").trim().slice(0, 60) || "default";
  if (body.action === "getReview") return json(getReview(user, body.date));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === "getNutrition") return json({ ok: true, version: VERSION, data: getNutrition(user) });
    else if (body.action === "upsertEntry") upsertEntry(user, body.entry);
    else if (body.action === "upsertDay") upsertDay(user, body.date, body.day);
    else if (body.action === "upsertProgram") upsertProgram(user, body.program);
    else if (body.action === "upsertWeight") upsertWeight(user, body.weight);
    else if (body.action === "upsertReview") upsertReview(user, body.date, body.sig, body.review);
    else return json({ ok: false, error: "unknown action" });
    return json({ ok: true, version: VERSION });
  } finally {
    lock.releaseLock();
  }
}

function sheet(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const headerRange = sh.getRange(1, 1, 1, headers.length);
    const existing = headerRange.getValues()[0];
    if (existing.some((header, index) => header && header !== headers[index])) {
      throw new Error("Sheet headers conflict with the nutrition schema. Existing data was not overwritten.");
    }
    if (existing.some((header, index) => header !== headers[index])) headerRange.setValues([headers]);
  }
  return sh;
}

function upsertEntry(user, entry) {
  const sh = sheet(user + " · Entries", ENTRY_HEADERS);
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 2, last - 1, 1).getValues() : [];
  const now = new Date();
  const rows = entry.items.map((i, idx) => [user, entry.id, idx, entry.date, entry.time, entry.text,
    i.name, i.qty, i.unit, i.grams, i.kcal, i.protein, i.carbs, i.fat, i.fiber, i.sugar, i.sodium,
    i.source, !!(entry.revoked || i.revoked), now, idx === 0 ? JSON.stringify(entry) : ""]);
  if (!rows.length) rows.push([user, entry.id, -1, entry.date, entry.time, entry.text,
    "", 0, "", 0, 0, 0, 0, 0, 0, 0, 0, "", !!entry.revoked, now, JSON.stringify(entry)]);
  const matching = ids.flatMap((row, index) => row[0] === entry.id ? [index + 2] : []);
  const contiguous = matching.length === rows.length && matching.every((row, index) => row === matching[0] + index);
  if (contiguous) {
    sh.getRange(matching[0], 1, rows.length, rows[0].length).setValues(rows);
  } else {
    sh.getRange(last + 1, 1, rows.length, rows[0].length).setValues(rows);
    if (matching.length) sh.getRangeList(matching.map(row => `A${row}:U${row}`)).clearContent();
  }
}

function upsertDay(user, date, d) {
  const sh = sheet(user + " · Days", DAY_HEADERS);
  upsertByKey(sh, 2, date, [user, date, d.intake.kcal, d.intake.protein, d.intake.carbs, d.intake.fat,
    d.intake.fiber, d.intake.sugar, d.intake.sodium, d.burn.total, d.targets.kcal, d.status, d.weightKg,
    new Date(), d.program || "maintain", JSON.stringify(d)]);
}

function upsertProgram(user, p) {
  const sh = sheet(user + " · Program", PROGRAM_HEADERS);
  upsertByKey(sh, 2, p.from, [user, p.from, p.program, p.label, p.setAt, new Date()]);
}

function upsertWeight(user, w) {
  const sh = sheet(user + " · Weight", WEIGHT_HEADERS);
  upsertByKey(sh, 2, w.date, [user, w.date, w.kg, w.setAt, new Date(), w.source || "manual"]);
}

function upsertReview(user, date, sig, r) {
  const sh = sheet(user + " · Reviews", REVIEW_HEADERS);
  const avoid = (r.avoid || []).map((a) => a.item + " (" + a.reason + " → " + a.instead + ")").join("; ");
  upsertByKey(sh, 2, date, [user, date, true, sig, r.verdict, r.summary, avoid,
    (r.keep || []).join(", "), r.next, JSON.stringify(r), new Date()]);
}

function getReview(user, date) {
  const sh = SpreadsheetApp.getActive().getSheetByName(user + " · Reviews");
  if (!sh || sh.getLastRow() < 2) return { ok: true, found: false };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, REVIEW_HEADERS.length).getDisplayValues();
  const row = rows.find((r) => r[1] === date && String(r[2]).toUpperCase() === "TRUE");
  if (!row) return { ok: true, found: false };
  return { ok: true, found: true, sig: row[3], review: JSON.parse(row[9]) };
}

function readRows(name) {
  const spreadsheet = SpreadsheetApp.getActive();
  const table = spreadsheet.getSheetByName(name);
  if (!table || table.getLastRow() < 2) return [];
  const values = table.getDataRange().getValues();
  const headers = values.shift();
  return values.map(values => Object.fromEntries(headers.map((header, index) => {
    let value = values[index];
    if (value instanceof Date) {
      value = header === "date" || header === "from"
        ? Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), "yyyy-MM-dd")
        : header === "time" ? Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), "HH:mm") : value.toISOString();
    }
    return [header, value];
  })));
}

function getNutrition(user) {
  const nutrients = ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium"];
  const groups = new Map();
  for (const row of readRows(user + " · Entries")) {
    if (!row.entryId || row.user && row.user !== user) continue;
    if (!groups.has(row.entryId)) groups.set(row.entryId, { rows: new Map(), metadata: null });
    const group = groups.get(row.entryId);
    group.rows.set(Number(row.itemIndex), row);
    if (row.entryJson) group.metadata = JSON.parse(row.entryJson);
  }
  const entries = [...groups.entries()].map(([id, group]) => {
    const rows = [...group.rows.entries()].sort((first, second) => first[0] - second[0]).map(pair => pair[1]);
    const first = rows[0];
    const removed = row => row.revoked === true || String(row.revoked).toUpperCase() === "TRUE";
    const entry = { ...(group.metadata || {}), id, date: first.date, time: first.time, text: first.text };
    entry.revoked = group.metadata ? !!group.metadata.revoked && rows.every(removed) : rows.every(removed);
    entry.items = rows.filter(row => Number(row.itemIndex) >= 0).map(row => {
      const saved = group.metadata && group.metadata.items && group.metadata.items[Number(row.itemIndex)] || {};
      return {
        ...saved, input: saved.input || row.food, name: row.food, qty: Number(row.qty), unit: row.unit,
        grams: row.grams === "" ? null : Number(row.grams), source: row.source || null,
        found: saved.found === undefined ? !!row.source : saved.found,
        revoked: entry.revoked ? !!saved.revoked : removed(row),
        ...Object.fromEntries(nutrients.map(key => [key, Number(row[key]) || 0])),
      };
    });
    entry.totals = Object.fromEntries(nutrients.map(key => [key,
      Math.round(entry.items.filter(item => !item.revoked).reduce((total, item) => total + item[key], 0) * 10) / 10]));
    return entry;
  });
  const days = {};
  for (const row of readRows(user + " · Days")) {
    const saved = row.dayJson ? JSON.parse(row.dayJson) : {};
    days[row.date] = {
      ...saved,
      intake: Object.fromEntries(nutrients.map(key => [key, Number(row[key === "kcal" ? "intakeKcal" : key]) || 0])),
      targets: { ...(saved.targets || {}), kcal: Number(row.targetKcal) || 0 },
      burn: { ...(saved.burn || {}), total: Number(row.burnKcal) || 0 },
      status: row.status, weightKg: Number(row.weightKg) || null, program: row.program || "maintain",
    };
  }
  const programs = readRows(user + " · Program").map(row => ({ from: row.from, program: row.program, label: row.label, setAt: row.setAt }));
  const weights = readRows(user + " · Weight").map(row => ({ date: row.date, kg: Number(row.kg), setAt: row.setAt, source: row.source || "manual" }));
  const coach = {};
  for (const row of readRows(user + " · Reviews")) {
    if (row.json && (row.reviewed === true || String(row.reviewed).toUpperCase() === "TRUE")) {
      coach[row.date] = { sig: row.sig, review: JSON.parse(row.json), at: row.updatedAt };
    }
  }
  return { entries, days, programs, weights, coach };
}

function upsertByKey(sh, col, key, row) {
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, col, last - 1, 1).getDisplayValues() : [];
  const idx = keys.findIndex((r) => r[0] === key);
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
