const setupModal = document.createElement("div");
setupModal.className = "setup-overlay";
setupModal.hidden = true;
setupModal.setAttribute("role", "dialog");
setupModal.setAttribute("aria-modal", "true");
setupModal.setAttribute("aria-labelledby", "setup-title");
setupModal.innerHTML = `<section class="setup-dialog"><header><h2 id="setup-title">Settings</h2><button type="button" id="setup-close" aria-label="Close settings">×</button></header>
  <div class="setup-account"><span id="setup-account-email"></span><a id="setup-link-strava" href="/api/strava/connect?link=1" hidden>Link Strava to this tracker</a></div>
  <nav id="setup-steps" aria-label="Setup steps"></nav><form id="setup-form">
    <section data-setup-step="0"><h3>1. Google sheet</h3><p class="setup-purpose">Your private Google sheet keeps a backup of foods and portions, calories and nutrients, daily targets, weight history and nutrition reviews. Garmin and Strava login tokens are never stored in the sheet.</p><a href="#sheet-instructions" class="setup-instructions-link">Instructions</a>
      <div id="sheet-instructions" class="setup-instructions" hidden><ol>
        <li>Open <a href="https://sheets.google.com" target="_blank" rel="noopener">Google Sheets</a>, create a blank spreadsheet and give it a name such as My Food Log.</li>
        <li>Select Generate token below, then Download script. The file contains your private token; do not share it.</li>
        <li>In your spreadsheet select Extensions, then Apps Script. Delete the sample code. Open the downloaded file in a text editor, copy all its text into the script editor and save.</li>
        <li>Select Deploy, New deployment, the gear icon, then Web app. Choose Execute as: Me and Who has access: Anyone. Your sheet stays private; script requests require your secret token.</li>
        <li>Select Deploy and authorise your own script with Google. Only continue past an unverified-app warning if this is the script you just created.</li>
        <li>Copy the Web app URL ending in /exec below and select Save and check. If you edit the script later, deploy a new version.</li>
      </ol></div>
      <div class="setup-actions"><button type="button" id="setup-generate-token">Generate token</button><button type="button" id="setup-download-script" disabled>Download script</button></div><p id="setup-download-note">First generate a token to enable the private script download.</p>
      <label>Web app deployment URL<input name="sheets_url" type="url" placeholder="https://script.google.com/macros/s/.../exec" /></label>
      <label>Existing sheet token, if you already have one<input name="sheets_token" type="password" autocomplete="new-password" /></label>
      <button type="button" data-check="sheets">Check saved connection</button></section>
    <section data-setup-step="1" hidden><h3>2. LLM food analysis</h3><p class="setup-purpose">Your chosen model estimates calories and nutrients and prepares daily reviews through LiteLLM. Meal descriptions and nutrition details are sent to that model's provider, not your provider login tokens or sheet token. Provider usage limits or charges may apply. Model and API-key changes are made only in Settings.</p><a href="#gemini-instructions" class="setup-instructions-link">Instructions</a>
      <div id="gemini-instructions" class="setup-instructions" hidden><ol>
        <li>Choose your provider and create an API key in its console: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>, <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">OpenAI</a>, <a href="https://console.anthropic.com" target="_blank" rel="noopener">Anthropic</a>, or your chosen provider.</li>
        <li>Copy the private API key below. Use a provider API key, not your website login password.</li>
        <li>Enter an available model ID from the provider's model list. For another LiteLLM provider, select Other and enter its provider name. Providers needing additional credentials cannot use a single API-key setup.</li>
        <li>Select Save and check. This sends a small test request and may count toward usage. The app uses your saved preference until you change it here in Settings.</li>
      </ol></div><label>LLM provider<select name="llm_provider"><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="groq">Groq</option><option value="mistral">Mistral</option><option value="openrouter">OpenRouter</option><option value="other">Other LiteLLM provider</option></select></label>
      <label id="llm-custom-provider" hidden>LiteLLM provider name<input name="llm_custom_provider" pattern="[a-zA-Z0-9_\\-]+" /></label>
      <label>Your provider API key<input name="llm_api_key" type="password" autocomplete="new-password" /></label>
      <label>Model ID<input name="llm_model" type="text" value="gemini-flash-lite-latest" pattern="[a-zA-Z0-9/._:@\\-]+" /></label>
      <button type="button" data-check="llm">Check saved connection</button></section>
    <p id="setup-status" role="status"></p><footer><button type="button" id="setup-back">Back</button><button type="button" id="setup-skip">Skip for now</button><button type="submit" id="setup-save">Save and check</button></footer>
  </form></section>`;
document.body.append(setupModal);
const setupForm = setupModal.querySelector("form");
const setupStatus = document.getElementById("setup-status");
const stepNames = ["Google sheet", "LLM model"];
const stepKeys = ["sheets", "llm"];
let setupStep = 0;
let setupState = null;
let setupBusy = false;
let setupTrigger = null;

async function setupRequest(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-App-Settings": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !["/api/login", "/api/mfa", "/api/guest/login"].includes(path)) location.replace("/dashboard.html");
    throw new Error(data.detail || "Could not complete this step.");
  }
  return data;
}

function renderSetupStep() {
  setupModal.querySelectorAll("[data-setup-step]").forEach(section => { section.hidden = Number(section.dataset.setupStep) !== setupStep; });
  document.getElementById("setup-steps").innerHTML = stepNames.map((name, index) => `<button type="button" data-step="${index}" aria-current="${index === setupStep ? "step" : "false"}">${index + 1}. ${name}<small>${setupState?.[stepKeys[index]]?.ready ? "Ready" : "Not ready"}</small></button>`).join("");
  document.getElementById("setup-back").disabled = setupStep === 0 || setupBusy;
  document.getElementById("setup-save").textContent = "Save and check";
  document.getElementById("setup-skip").textContent = setupState?.nutritionReady ? "Open FitMate" : "Use Dashboard for now";
}

async function refreshSetup() {
  setupState = await setupRequest("/api/settings/integrations");
  setupForm.elements.sheets_url.value = setupState.sheets.url;
  setupForm.elements.llm_model.value = setupState.llm.model;
  const known = [...setupForm.elements.llm_provider.options].some(option => option.value === setupState.llm.provider);
  setupForm.elements.llm_provider.value = known ? setupState.llm.provider : "other";
  setupForm.elements.llm_custom_provider.value = known ? "" : setupState.llm.provider;
  document.getElementById("llm-custom-provider").hidden = known;
  for (const [name, configured] of [["sheets_token", setupState.sheets.tokenConfigured], ["llm_api_key", setupState.llm.keyConfigured]]) {
    setupForm.elements[name].value = "";
    setupForm.elements[name].placeholder = configured ? "Saved privately" : "Not configured";
  }
  document.getElementById("setup-download-script").disabled = !setupState.sheets.tokenConfigured || setupBusy;
  document.getElementById("setup-download-note").textContent = setupState.sheets.tokenConfigured ? "Your private token is saved. Download the script and follow Instructions." : "First generate a token to enable the private script download.";
  document.getElementById("setup-account-email").textContent = setupState.account?.email ? `Tracker email: ${setupState.account.email}` : "To combine an existing Garmin tracker with Strava, sign in with Garmin once and link Strava here.";
  document.getElementById("setup-link-strava").hidden = !setupState.account?.canLinkStrava;
  renderSetupStep();
}

async function openSetup(event) {
  setupTrigger = event?.currentTarget || document.activeElement;
  setupModal.hidden = false;
  setupStatus.textContent = "Loading your setup…";
  document.getElementById("setup-close").focus();
  try {
    await refreshSetup();
    const missing = stepKeys.findIndex(key => !setupState[key].ready);
    setupStep = missing < 0 ? 1 : missing;
    renderSetupStep();
    setupStatus.textContent = missing < 0 ? "All connections are ready. Select Open FitMate to open your logs." : "";
  }
  catch (error) { setupStatus.textContent = error.message; }
}

function closeSetup() {
  setupModal.hidden = true;
  for (const name of ["llm_api_key", "sheets_token"]) setupForm.elements[name].value = "";
  if (setupState?.nutritionReady) location.replace("/");
  else if (location.pathname !== "/dashboard.html") location.replace("/dashboard.html?setup=skipped");
  else setupTrigger?.focus();
}
document.getElementById("setup-close").addEventListener("click", closeSetup);
document.getElementById("setup-back").addEventListener("click", () => { setupStep = Math.max(0, setupStep - 1); setupStatus.textContent = ""; renderSetupStep(); });
document.getElementById("setup-skip").addEventListener("click", closeSetup);
document.getElementById("setup-steps").addEventListener("click", event => { const button = event.target.closest("[data-step]"); if (button && !setupBusy) { setupStep = Number(button.dataset.step); setupStatus.textContent = ""; renderSetupStep(); } });
setupModal.querySelectorAll(".setup-instructions-link").forEach(link => link.addEventListener("click", event => { event.preventDefault(); const panel = setupModal.querySelector(link.getAttribute("href")); panel.hidden = !panel.hidden; link.setAttribute("aria-expanded", String(!panel.hidden)); }));
document.getElementById("configure-chat-integrations")?.addEventListener("click", openSetup);
const setupDashboardButton = document.createElement("button");
setupDashboardButton.type = "button"; setupDashboardButton.className = "btn-ghost"; setupDashboardButton.textContent = "Settings";
const dashboardSettings = document.getElementById("settings-modal");
if (dashboardSettings) {
  setupDashboardButton.textContent = "Sheets and LLM";
  dashboardSettings.querySelector(".modal-body")?.append(setupDashboardButton);
} else document.getElementById("logout-btn")?.before(setupDashboardButton);
setupDashboardButton.addEventListener("click", event => { dashboardSettings?.classList.add("hidden"); openSetup(event); });

async function busySetup(action) {
  if (setupBusy) return;
  setupBusy = true;
  setupModal.querySelectorAll("button").forEach(button => { button.disabled = true; });
  try { await action(); }
  catch (error) { setupStatus.textContent = error.message; }
  finally { setupBusy = false; setupModal.querySelectorAll("button").forEach(button => { button.disabled = false; }); renderSetupStep(); document.getElementById("setup-download-script").disabled = !setupState?.sheets.tokenConfigured; }
}

document.getElementById("setup-generate-token").addEventListener("click", () => busySetup(async () => { await setupRequest("/api/settings/sheets/token", {}); await refreshSetup(); setupStatus.textContent = "Your private token is saved. Download the script, then follow Instructions."; }));
setupModal.querySelectorAll("[data-check]").forEach(button => button.addEventListener("click", () => busySetup(async () => { await setupRequest(`/api/settings/check/${button.dataset.check}`, {}); await refreshSetup(); setupStatus.textContent = "Connection ready."; })));
document.getElementById("setup-download-script").addEventListener("click", () => {
  if (!setupState?.sheets.tokenConfigured) { setupStatus.textContent = "Generate your sheet token first."; return; }
  const download = document.createElement("a"); download.href = "/api/settings/sheets/script"; download.download = "nutrition_sheets.gs"; document.body.append(download); download.click(); download.remove();
});

setupForm.addEventListener("submit", event => {
  event.preventDefault();
  busySetup(async () => {
    const fields = setupForm.elements;
    if (setupStep === 0) {
      if (!fields.sheets_url.value || !fields.sheets_url.checkValidity()) throw new Error("Paste the valid Web app URL ending in /exec.");
      const body = { sheets_url: fields.sheets_url.value.trim(), sheets_enabled: false };
      if (fields.sheets_token.value.trim()) body.sheets_token = fields.sheets_token.value.trim();
      await setupRequest("/api/settings/integrations", body); await setupRequest("/api/settings/check/sheets", {});
    } else if (setupStep === 1) {
      if (!fields.llm_model.value || !fields.llm_model.checkValidity()) throw new Error("Enter a valid model ID.");
      const provider = fields.llm_provider.value === "other" ? fields.llm_custom_provider.value.trim() : fields.llm_provider.value;
      if (!provider || !fields.llm_custom_provider.checkValidity()) throw new Error("Enter a valid LiteLLM provider name.");
      const body = { llm_provider: provider, llm_model: fields.llm_model.value.trim(), llm_enabled: false };
      if (fields.llm_api_key.value.trim()) body.llm_api_key = fields.llm_api_key.value.trim();
      if (setupState.llm.provider !== provider && !body.llm_api_key) throw new Error("Enter the API key for the new provider.");
      await setupRequest("/api/settings/integrations", body); await setupRequest("/api/settings/check/llm", {});
    }
    await refreshSetup(); setupStatus.textContent = "Saved and ready.";
    if (setupStep < 1) { setupStep++; renderSetupStep(); }
  });
});

setupForm.elements.llm_provider.addEventListener("change", () => {
  document.getElementById("llm-custom-provider").hidden = setupForm.elements.llm_provider.value !== "other";
  setupForm.elements.llm_api_key.value = "";
  setupForm.elements.llm_model.value = "";
});

setupModal.addEventListener("keydown", event => {
  if (event.key === "Escape" && !setupBusy) closeSetup();
  if (event.key === "Tab") {
    const controls = [...setupModal.querySelectorAll("button,a,input,textarea,select")].filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

const setupQuery = new URLSearchParams(location.search);
if (setupQuery.has("setup") && setupQuery.get("setup") !== "skipped") {
  (async () => {
    try {
      const session = await setupRequest("/api/session");
      if (session.authenticated) await openSetup();
    } catch (error) {
      const message = document.getElementById("start-setup-error");
      if (message) message.textContent = error.message;
    }
  })();
}
if (setupQuery.get("strava") === "app_unavailable") {
  const message = document.getElementById("start-setup-error");
  if (message) message.textContent = "Strava sign-in is temporarily unavailable. The application owner needs to restore the Strava app configuration.";
}
document.dispatchEvent(new Event("fitmate-setup-ready"));
if (location.pathname === "/dashboard.html") {
  const nutritionElements = [document.querySelector(".nutrition-panel"), document.getElementById("nutri-fab"), document.getElementById("nutri-chatbox")].filter(Boolean);
  nutritionElements.forEach(element => { element.hidden = true; });
  setupRequest("/api/session").then(session => {
    nutritionElements.forEach(element => { element.hidden = !session.nutritionReady; });
    if (session.authenticated && !session.nutritionReady && !setupQuery.has("setup")) openSetup();
  }).catch(() => {});
}