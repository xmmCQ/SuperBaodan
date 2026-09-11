export function createSettingsDialog({ elements: el, closeActiveLogin, loadAccounts, loadModelsConfig, loadModelCatalog, loadSkills, loadProjectPrompt = () => {}, canLeaveProjectPrompt = async () => true, showError }) {
  let toastTimer;
  let currentTab = 'accounts';

  function open() {
    el.settingsDialog.showModal();
    return activateTab("accounts");
  }

  async function close() {
    if (currentTab === 'projectPrompt' && !await canLeaveProjectPrompt()) return;
    closeActiveLogin();
    clearTimeout(toastTimer);
    el.settingsToast.classList.add("hidden");
    el.settingsDialog.close();
  }

  async function activateTab(name) {
    if (name !== currentTab && currentTab === 'projectPrompt' && !await canLeaveProjectPrompt()) return;
    currentTab = name;
    for (const button of document.querySelectorAll("[data-settings-tab]")) button.classList.toggle("active", button.dataset.settingsTab === name);
    for (const tab of document.querySelectorAll(".settings-tab")) tab.classList.remove("active");
    el[`${name}Tab`].classList.add("active");
    try {
      if (name === "accounts") await loadAccounts();
      if (name === "custom") await loadModelsConfig();
      if (name === "preferences") await loadModelCatalog();
      if (name === "skills") await loadSkills({ preserveSelection: true });
      if (name === 'projectPrompt') await loadProjectPrompt();
    } catch (error) { showError(error); }
  }

  function toast(message, type = "success") {
    if (!message) return;
    clearTimeout(toastTimer);
    el.settingsToast.textContent = message;
    el.settingsToast.className = `settings-toast ${type === "success" ? "" : type}`.trim();
    toastTimer = setTimeout(() => el.settingsToast.classList.add("hidden"), 3000);
  }

  el.settingsDialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  return { open, close, activateTab, toast };
}
