const integrationForm = document.getElementById("integration-settings-form");
const integrationStatus = document.getElementById("integration-settings-status");
const integrationModal = document.createElement("div");
integrationModal.className = "integration-overlay hidden";
integrationModal.id = "integration-editor";
integrationModal.setAttribute("role", "dialog");
integrationModal.setAttribute("aria-modal", "true");
integrationModal.setAttribute("aria-labelledby", "integration-editor-title");
const integrationPanel = document.createElement("div");
integrationPanel.className = "integration-dialog";
const integrationHeading = document.createElement("div");
integrationHeading.className = "integration-heading";
const integrationTitle = document.createElement("h2");
integrationTitle.id = "integration-editor-title";
integrationTitle.textContent = "Integration settings";
const integrationClose = document.createElement("button");
integrationClose.type = "button";
integrationClose.textContent = "Close";
integrationClose.setAttribute("aria-label", "Close integration settings");
integrationHeading.append(integrationTitle, integrationClose);
const integrationBody = document.createElement("div");
integrationBody.className = "integration-body";
integrationBody.append(integrationForm);
integrationPanel.append(integrationHeading, integrationBody);
integrationModal.append(integrationPanel);
document.body.append(integrationModal);
let integrationReturnFocus = null;

function closeIntegrationSettings() {
  integrationModal.classList.add("hidden");
  integrationReturnFocus?.focus();
}

function openIntegrationSettings(event) {
  integrationReturnFocus = event?.currentTarget || document.activeElement;
  integrationModal.classList.remove("hidden");
  document.getElementById("integration-settings-details").open = true;
  loadIntegrationSettings();
  integrationClose.focus();
}

integrationClose.addEventListener("click", closeIntegrationSettings);
integrationModal.addEventListener("click", event => {
  if (event.target === integrationModal) closeIntegrationSettings();
});
integrationModal.addEventListener("keydown", event => {
  if (event.key === "Escape") closeIntegrationSettings();
  if (event.key === "Tab") {
    const controls = [...integrationModal.querySelectorAll("button,input,select,textarea,summary")].filter(control => !control.disabled && control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
const integrationDashboardButton = document.createElement("button");
integrationDashboardButton.id = "configure-dashboard-integrations";
integrationDashboardButton.className = "btn-ghost";
integrationDashboardButton.type = "button";
integrationDashboardButton.textContent = "Integrations";
document.getElementById("logout-btn")?.before(integrationDashboardButton);
integrationDashboardButton.addEventListener("click", openIntegrationSettings);

async function loadIntegrationSettings() {
  try {
    const settings = await api("/api/settings/integrations");
    integrationForm.elements.strava_client_id.value = settings.strava.client_id;
    integrationForm.elements.sheets_url.value = settings.sheets.url;
    integrationForm.elements.sheets_enabled.checked = settings.sheets.enabled;
    integrationForm.elements.gemini_model.value = settings.gemini.model;
    integrationForm.elements.gemini_enabled.checked = settings.gemini.enabled;
    const secrets = {
      strava_client_secret: settings.strava.secretConfigured,
      sheets_token: settings.sheets.tokenConfigured,
      gemini_api_key: settings.gemini.keyConfigured,
      usda_api_key: settings.usda.keyConfigured,
    };
    for (const [name, configured] of Object.entries(secrets)) {
      integrationForm.elements[name].value = "";
      integrationForm.elements[name].placeholder = configured ? "Configured" : "Not configured";
    }
    integrationStatus.textContent = "";
  } catch (error) {
    integrationStatus.textContent = error.message;
  }
}

document.getElementById("configure-integrations").addEventListener("click", openIntegrationSettings);

integrationForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!integrationForm.reportValidity()) return;
  const button = document.getElementById("save-integrations");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(integrationForm));
    data.sheets_enabled = integrationForm.elements.sheets_enabled.checked;
    data.gemini_enabled = integrationForm.elements.gemini_enabled.checked;
    for (const name of ["strava_client_secret", "sheets_token", "gemini_api_key", "usda_api_key"]) {
      if (!data[name]) delete data[name];
    }
    if (!data.gemini_model) delete data.gemini_model;
    const saved = await api("/api/settings/integrations", {
      method: "POST", headers: { "Content-Type": "application/json", "X-App-Settings": "1" }, body: JSON.stringify(data),
    });
    if (typeof stravaConfigured !== "undefined") stravaConfigured = saved.strava.configured;
    if (typeof updateConnectButtons === "function") updateConnectButtons();
    await loadIntegrationSettings();
    integrationStatus.textContent = "Settings saved.";
  } catch (error) {
    integrationStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});