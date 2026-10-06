/**
 * Training Lab — nutrition and login storage (Google Apps Script Web App), version 6.
 *
 * Deploy: Extensions ▸ Apps Script ▸ paste this file ▸ set TOKEN to the value in
 * backend/nutrition_secrets.json ("sheets_token") ▸ Deploy ▸ Manage deployments ▸
 * edit the existing deployment ▸ Version: New version ▸ Deploy (keeps the same URL).
 *
 * v5 adds the per-user "· Reviews" tab so a Gemini day review is stored once and
 * reused (upsertReview / getReview) instead of spending quota on every page load.
 */

const TOKEN = "PASTE_SHEETS_TOKEN_HERE"; // must match backend/nutrition_secrets.json
const VERSION = 6;
const ENTRY_HEADERS = ["user","entryId","itemIndex","date","time","text","food","qty","unit","grams",
  "kcal","protein","carbs","fat","fiber","sugar","sodium","source","revoked","updatedAt"];
const DAY_HEADERS = ["user","date","intakeKcal","protein","carbs","fat","fiber","sugar","sodium",
  "burnKcal","targetKcal","status","weightKg","updatedAt","program"];
const PROGRAM_HEADERS = ["user","from","program","label","setAt","updatedAt"];
const WEIGHT_HEADERS = ["user","date","kg","setAt","updatedAt"];
const REVIEW_HEADERS = ["user","date","reviewed","sig","verdict","summary","avoid","keep","next","json","updatedAt"];
const AUTH_HEADERS = ["sessionKey","provider","ciphertext","encryptionKey","expiresAt","updatedAt"];

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
    if (["upsertAuth", "getAuth", "deleteAuth"].includes(body.action)) return json(authRecord(body));
    if (body.action === "upsertEntry") upsertEntry(user, body.entry);
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
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

function authRecord(body) {
  if (body.provider !== "garmin" || !/^[a-f0-9]{64}$/.test(String(body.sessionKey || ""))) {
    return { ok: false, error: "invalid login lookup" };
  }
  const sh = sheet("Login storage", AUTH_HEADERS);
  const rows = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, AUTH_HEADERS.length).getValues() : [];
  const index = rows.findIndex((row) => row[0] === body.sessionKey && row[1] === body.provider);
  if (body.action === "deleteAuth") {
    if (index >= 0) sh.deleteRow(index + 2);
    return { ok: true, version: VERSION };
  }
  if (body.action === "getAuth") {
    if (index < 0) return { ok: true, found: false };
    const row = rows[index];
    if (Number(row[4]) <= Date.now() / 1000) {
      sh.deleteRow(index + 2);
      return { ok: true, found: false };
    }
    return { ok: true, found: true, record: {
      ciphertext: row[2], encryptionKey: row[3], expiresAt: Number(row[4])
    } };
  }
  if (!/^[A-Za-z0-9_-]{43}=$/.test(String(body.encryptionKey || "")) ||
      !/^gAAAA[A-Za-z0-9_=-]+$/.test(String(body.ciphertext || "")) ||
      body.ciphertext.length > 45000 || !Number.isFinite(body.expiresAt) ||
      body.expiresAt <= Date.now() / 1000) {
    return { ok: false, error: "invalid login record" };
  }
  const row = [body.sessionKey, body.provider, body.ciphertext, body.encryptionKey, body.expiresAt, new Date()];
  if (index >= 0) sh.getRange(index + 2, 1, 1, AUTH_HEADERS.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, version: VERSION };
}

function upsertEntry(user, entry) {
  const sh = sheet(user + " · Entries", ENTRY_HEADERS);
  const last = sh.getLastRow();
  if (last > 1) {
    const ids = sh.getRange(2, 2, last - 1, 1).getValues();
    for (let r = ids.length - 1; r >= 0; r--) if (ids[r][0] === entry.id) sh.deleteRow(r + 2);
  }
  const now = new Date();
  const rows = entry.items.map((i, idx) => [user, entry.id, idx, entry.date, entry.time, entry.text,
    i.name, i.qty, i.unit, i.grams, i.kcal, i.protein, i.carbs, i.fat, i.fiber, i.sugar, i.sodium,
    i.source, !!(entry.revoked || i.revoked), now]);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function upsertDay(user, date, d) {
  const sh = sheet(user + " · Days", DAY_HEADERS);
  upsertByKey(sh, 2, date, [user, date, d.intake.kcal, d.intake.protein, d.intake.carbs, d.intake.fat,
    d.intake.fiber, d.intake.sugar, d.intake.sodium, d.burn.total, d.targets.kcal, d.status, d.weightKg,
    new Date(), d.program || "maintain"]);
}

function upsertProgram(user, p) {
  const sh = sheet(user + " · Program", PROGRAM_HEADERS);
  upsertByKey(sh, 2, p.from, [user, p.from, p.program, p.label, p.setAt, new Date()]);
}

function upsertWeight(user, w) {
  const sh = sheet(user + " · Weight", WEIGHT_HEADERS);
  upsertByKey(sh, 2, w.date, [user, w.date, w.kg, w.setAt, new Date()]);
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
