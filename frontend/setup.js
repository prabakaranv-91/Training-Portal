const setupModal = document.createElement("div");
setupModal.className = "setup-overlay";
setupModal.hidden = true;
setupModal.setAttribute("role", "dialog");
setupModal.setAttribute("aria-modal", "true");
setupModal.setAttribute("aria-labelledby", "setup-title");
setupModal.innerHTML = `<section class="setup-dialog"><header><div><h2 id="setup-title">Settings</h2><p id="setup-profile" class="setup-profile" hidden></p></div><button type="button" id="setup-close" aria-label="Close settings" title="Close settings">×</button></header>
  <section class="setup-account" aria-labelledby="setup-apps-title"><div class="setup-apps"><h3 id="setup-apps-title">Connected apps</h3><ul id="connected-apps-list" class="setup-connection-list"></ul></div><a id="setup-link-strava" class="setup-link" href="/api/strava/connect?link=1" hidden>Link Strava to this tracker <span aria-hidden="true">↗</span></a></section>
  <form id="setup-form"><section id="setup-ready-summary" class="setup-ready-summary" aria-labelledby="setup-connections-title" hidden>
    <div class="setup-section-heading"><h3 id="setup-connections-title">Nutrition connections</h3><span class="setup-status-pill is-connected">Ready</span></div>
    <ul class="setup-connection-list"><li><div class="setup-connection-name"><strong>Google Sheet</strong><span>Verified connection</span></div><span class="setup-status-pill is-connected">Connected</span></li><li><div class="setup-connection-name"><strong>AI model</strong><span id="setup-model-detail"></span></div><span class="setup-status-pill is-connected">Connected</span></li></ul>
    <div class="setup-summary-actions"><button type="button" id="edit-integration-settings">Edit connections</button></div></section>
    <nav id="setup-steps" aria-label="Settings sections"></nav>
    <section data-setup-step="0"><h3>1. Google sheet</h3><p class="setup-purpose">Food entries, nutrition details, targets, programs, weights and reviews are stored only in your Google sheet.</p><a href="#sheet-instructions" class="setup-instructions-link">Instructions</a>
      <div id="sheet-instructions" class="setup-instructions" hidden><ol>
        <li>Open <a href="https://sheets.google.com" target="_blank" rel="noopener">Google Sheets</a>, create a blank spreadsheet and give it a name such as My Food Log.</li>
        <li>Select Generate token below, then Download script.</li>
        <li>In your spreadsheet select Extensions, then Apps Script. Delete the sample code. Open the downloaded file in a text editor, copy all its text into the script editor and save.</li>
        <li>Select Deploy, New deployment, the gear icon, then Web app. Choose Execute as: Me and Who has access: Anyone.</li>
        <li>Select Deploy and authorise your own script with Google. Only continue past an unverified-app warning if this is the script you just created.</li>
        <li>Copy the Web app URL ending in /exec below and select Save and check. Version 8 is required. To upgrade an existing script, use Deploy, Manage deployments, Edit, New version, Deploy and keep the same URL.</li>
      </ol></div>
      <div class="setup-actions"><button type="button" id="setup-generate-token">Generate token</button><button type="button" id="setup-download-script" disabled>Download script</button></div><p id="setup-download-note">Generate a token to enable the script download.</p>
      <label>Web app deployment URL<input name="sheets_url" type="url" placeholder="https://script.google.com/macros/s/.../exec" /></label>
    </section>
    <section data-setup-step="1" hidden><h3>2. Choose your AI model</h3><p class="setup-purpose">Select an AI provider and model for food estimates and daily reviews. Provider usage limits or charges may apply.</p>
      <label>AI provider<select name="llm_provider"><option value="">Choose a provider</option><option value="gemini">Google AI</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="groq">Groq</option><option value="mistral">Mistral</option><option value="openrouter">OpenRouter</option><option value="other">Other provider</option></select></label>
      <label id="llm-custom-provider" hidden>LiteLLM provider ID<input name="llm_custom_provider" pattern="[a-zA-Z0-9_\\-]+" /></label>
      <p class="setup-key-guide"><a id="ai-key-instructions" href="https://docs.litellm.ai/docs/providers" target="_blank" rel="noopener">API key instructions</a></p>
      <label>AI provider API key<input name="llm_api_key" type="password" autocomplete="new-password" /></label>
      <label>AI model<select name="llm_model"><option value="">Choose a model</option></select></label>
      <label id="llm-custom-model" hidden>Custom model ID<input name="llm_custom_model" pattern="[a-zA-Z0-9/._:@\\-]+" /></label>
    </section>
    <p id="setup-status" role="status"></p><footer><button type="button" id="setup-back">Back</button><button type="button" id="setup-skip">Skip for now</button><button type="submit" id="setup-save">Save and check</button></footer>
  </form></section>`;
document.body.append(setupModal);
const setupForm = setupModal.querySelector("form");
const setupStatus = document.getElementById("setup-status");
const stepNames = ["Google sheet", "AI model"];
const stepKeys = ["sheets", "llm"];
let setupStep = 0;
let setupState = null;
let setupBusy = false;
let setupTrigger = null;
let editingIntegrationSettings = false;
const AI_MODELS = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-flash-lite-latest"],
  openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  groq: ["llama-3.3-70b-versatile", "llama-4-scout-17b-16e-instruct", "openai/gpt-oss-20b"],
  mistral: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo"],
  openrouter: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
};
const API_KEY_GUIDES = {
  gemini: "https://aistudio.google.com/apikey",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys/",
  openrouter: "https://openrouter.ai/settings/keys",
};
const API_KEY_GUIDE_LABELS = {
  gemini: "Google AI API key setup",
  openai: "OpenAI API key setup",
  anthropic: "Anthropic API key setup",
  groq: "Groq API key setup",
  mistral: "Mistral API key setup",
  openrouter: "OpenRouter API key setup",
};

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
  const ready = Boolean(setupState?.nutritionReady);
  const summary = ready && !editingIntegrationSettings;
  document.getElementById("setup-ready-summary").hidden = !summary;
  document.getElementById("setup-steps").hidden = summary;
  setupModal.querySelector("#setup-form footer").hidden = summary;
  setupModal.querySelectorAll("[data-setup-step]").forEach(section => { section.hidden = summary || Number(section.dataset.setupStep) !== setupStep; });
  document.getElementById("setup-steps").innerHTML = stepNames.map((name, index) => `<button type="button" data-step="${index}" aria-current="${index === setupStep ? "step" : "false"}">${index + 1}. ${name}<small>${setupState?.[stepKeys[index]]?.ready ? "Ready" : "Not ready"}</small></button>`).join("");
  document.getElementById("setup-back").disabled = setupStep === 0 || setupBusy;
  document.getElementById("setup-save").textContent = "Save and check";
  document.getElementById("setup-skip").textContent = setupState?.nutritionReady ? "Open Fit Squad" : "Use Dashboard for now";
}

function renderModelOptions(savedModel = "") {
  const fields = setupForm.elements;
  const provider = fields.llm_provider.value === "other" ? fields.llm_custom_provider.value : fields.llm_provider.value;
  const select = fields.llm_model;
  const models = AI_MODELS[provider] || [];
  select.innerHTML = '<option value="">Choose a model</option>' + models.map(model => `<option value="${model}">${model}</option>`).join("");
  if (savedModel && !models.includes(savedModel)) select.add(new Option(savedModel, savedModel));
  select.add(new Option("Enter a custom model ID", "__custom__"));
  select.value = savedModel && [...select.options].some(option => option.value === savedModel) ? savedModel : "";
  document.getElementById("llm-custom-model").hidden = select.value !== "__custom__";
  const guide = document.getElementById("ai-key-instructions");
  guide.href = API_KEY_GUIDES[provider] || "https://docs.litellm.ai/docs/providers";
  guide.textContent = API_KEY_GUIDE_LABELS[provider] || "Other provider API key instructions";
  document.getElementById("llm-custom-provider").hidden = fields.llm_provider.value !== "other";
}

async function refreshSetup() {
  setupState = await setupRequest("/api/settings/integrations");
  setupForm.elements.sheets_url.value = setupState.sheets.url;
  const providerSelect = setupForm.elements.llm_provider;
  const providerKnown = [...providerSelect.options].some(option => option.value === setupState.llm.provider);
  providerSelect.value = providerKnown ? setupState.llm.provider : setupState.llm.provider ? "other" : "";
  setupForm.elements.llm_custom_provider.value = providerKnown ? "" : setupState.llm.provider || "";
  renderModelOptions(setupState.llm.model);
  if (setupState.llm.model && setupForm.elements.llm_model.value !== setupState.llm.model) {
    setupForm.elements.llm_model.value = "__custom__";
    setupForm.elements.llm_custom_model.value = setupState.llm.model;
    document.getElementById("llm-custom-model").hidden = false;
  }
  for (const [name, configured] of [["llm_api_key", setupState.llm.keyConfigured]]) {
    setupForm.elements[name].value = "";
    setupForm.elements[name].placeholder = configured ? "Configured" : "Not configured";
  }
  document.getElementById("setup-download-script").disabled = !setupState.sheets.tokenConfigured || setupBusy;
  document.getElementById("setup-download-note").textContent = setupState.sheets.tokenConfigured ? "Download the script and follow Instructions." : "Generate a token to enable the script download.";
  const apps = [{ name: "Garmin", connected: setupState.garmin.ready }, { name: "Strava", connected: setupState.strava.ready }];
  document.getElementById("connected-apps-list").innerHTML = apps.map(app => `<li><strong>${app.name}</strong><span class="setup-status-pill ${app.connected ? "is-connected" : "is-disconnected"}">${app.connected ? "Connected" : "Not connected"}</span></li>`).join("");
  const profile = document.getElementById("setup-profile");
  profile.textContent = setupState.account?.email || "";
  profile.hidden = !profile.textContent;
  const providerLabel = providerKnown ? providerSelect.selectedOptions[0]?.textContent : setupState.llm.provider;
  document.getElementById("setup-model-detail").textContent = [providerLabel, setupState.llm.model].filter(Boolean).join(" · ");
  document.getElementById("setup-link-strava").hidden = !setupState.account?.canLinkStrava || setupState.account?.stravaLinked;
  renderSetupStep();
}

async function verifySavedIntegrations() {
  const checks = [];
  if (!setupState.sheets.ready && setupState.sheets.enabled && setupState.sheets.url && setupState.sheets.tokenConfigured) {
    checks.push(setupRequest("/api/settings/check/sheets", {}));
  }
  if (!setupState.llm.ready && setupState.llm.enabled && setupState.llm.provider && setupState.llm.model && setupState.llm.keyConfigured) {
    checks.push(setupRequest("/api/settings/check/llm", {}));
  }
  if (!checks.length) return;
  setupStatus.textContent = "Checking saved connections…";
  const results = await Promise.allSettled(checks);
  await refreshSetup();
  if (results.some(result => result.status === "rejected")) {
    setupStatus.textContent = "A saved connection could not be verified. Check its settings and connection.";
  }
}

async function openSetup(event) {
  setupTrigger = event?.currentTarget || document.activeElement;
  editingIntegrationSettings = false;
  setupModal.hidden = false;
  setupStatus.textContent = "Loading your setup…";
  document.getElementById("setup-close").focus();
  try {
    await refreshSetup();
    await verifySavedIntegrations();
    const missing = stepKeys.findIndex(key => !setupState[key].ready);
    editingIntegrationSettings = missing >= 0;
    setupStep = missing < 0 ? 0 : missing;
    renderSetupStep();
    setupStatus.textContent = "";
  }
  catch (error) { setupStatus.textContent = error.message; }
}

function closeSetup() {
  setupModal.hidden = true;
  setupForm.elements.llm_api_key.value = "";
  if (!setupState?.nutritionReady && location.pathname !== "/dashboard.html") location.replace("/dashboard.html?setup=skipped");
  else setupTrigger?.focus();
}
document.getElementById("edit-integration-settings").addEventListener("click", () => { editingIntegrationSettings = true; setupStep = 0; renderSetupStep(); });
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
  setupDashboardButton.textContent = "AI model settings";
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

document.getElementById("setup-generate-token").addEventListener("click", () => busySetup(async () => { await setupRequest("/api/settings/sheets/token", {}); await refreshSetup(); setupStatus.textContent = "Token generated. Download the script, then follow Instructions."; }));
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
      await setupRequest("/api/settings/integrations", body); await setupRequest("/api/settings/check/sheets", {});
    } else if (setupStep === 1) {
      const provider = fields.llm_provider.value === "other" ? fields.llm_custom_provider.value.trim() : fields.llm_provider.value;
      const model = fields.llm_model.value === "__custom__" ? fields.llm_custom_model.value.trim() : fields.llm_model.value;
      if (!provider || fields.llm_provider.value === "other" && !fields.llm_custom_provider.checkValidity()) throw new Error("Choose a valid AI provider.");
      if (!model || fields.llm_model.value === "__custom__" && !fields.llm_custom_model.checkValidity()) throw new Error("Choose a valid AI model.");
      const body = { llm_provider: provider, llm_model: model, llm_enabled: false };
      if (fields.llm_api_key.value.trim()) body.llm_api_key = fields.llm_api_key.value.trim();
      if (setupState.llm.provider !== provider && !body.llm_api_key) throw new Error("Enter the API key for the new provider.");
      await setupRequest("/api/settings/integrations", body); await setupRequest("/api/settings/check/llm", {});
    }
    await refreshSetup(); setupStatus.textContent = "Saved and ready.";
    if (setupStep < 1) { setupStep++; renderSetupStep(); }
  });
});

setupForm.elements.llm_provider.addEventListener("change", () => {
  setupForm.elements.llm_api_key.value = "";
  setupForm.elements.llm_custom_provider.value = "";
  setupForm.elements.llm_custom_model.value = "";
  renderModelOptions();
});
setupForm.elements.llm_custom_provider.addEventListener("input", () => renderModelOptions());
setupForm.elements.llm_model.addEventListener("change", () => {
  const custom = setupForm.elements.llm_model.value === "__custom__";
  document.getElementById("llm-custom-model").hidden = !custom;
  if (custom) setupForm.elements.llm_custom_model.focus();
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
document.dispatchEvent(new Event("fit-squad-settings-ready"));
if (location.pathname === "/dashboard.html") {
  const nutritionElements = [document.querySelector(".nutrition-panel"), document.getElementById("nutri-fab"), document.getElementById("nutri-chatbox")].filter(Boolean);
  nutritionElements.forEach(element => { element.hidden = true; });
  setupRequest("/api/session").then(session => {
    nutritionElements.forEach(element => { element.hidden = !session.nutritionReady; });
    if (session.authenticated && !session.nutritionReady && !setupQuery.has("setup")) openSetup();
  }).catch(() => {});
}
if (setupQuery.get("strava") === "link_login_required") {
  const message = document.getElementById("login-error");
  if (message) {
    message.textContent = "Sign in with Garmin before linking Strava to this tracker.";
    message.classList.remove("hidden");
  }
}