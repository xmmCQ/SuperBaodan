import { createModelsController } from './models-controller.js';
import { createAuthController } from './auth-controller.js';
import { createSkillsController } from './skills-controller.js';
import { createSettingsDialog } from './settings-dialog.js';
import { createProjectPrompt } from './project-prompt.js';
import { createReadingSettings } from '../core/reading-settings.js';

// Both entry points use the same controllers, event bindings and dialog markup.
export function createSettingsPanel({ state, elements: el, invoke, command, uiDialogs,
  showNotice, showError, loadBootstrap, updateStateFromAgent, renderMarkdown,
  markdownBodyWithoutFrontmatter, getWorkspace, readingContainer, captureContext }) {
  let settings;
  const showSettingsToast = (...args) => settings?.toast(...args);
  const models = createModelsController({ state: state.models, elements: el, invoke, command,
    uiDialogs, showNotice, showError, showSettingsToast, loadBootstrap, updateStateFromAgent, captureContext });
  const auth = createAuthController({ state: state.auth, elements: el, invoke, uiDialogs,
    showNotice, showError, showSettingsToast, loadBootstrap, loadModelCatalog: models.loadModelCatalog });
  const skills = createSkillsController({ state: state.skills, elements: el, invoke, uiDialogs,
    renderMarkdown, markdownBodyWithoutFrontmatter, showNotice, showError, showSettingsToast,
    getWorkspaceId: () => getWorkspace()?.id || null });
  const projectPrompt = createProjectPrompt({ mount: el.projectPromptTab, invoke, getWorkspace, uiDialogs });
  settings = createSettingsDialog({ elements: el, closeActiveLogin: auth.closeActiveLogin,
    loadAccounts: auth.loadAccounts,
    loadModelsConfig: () => state.models.modelsConfig ? undefined : models.loadModelsConfig(),
    loadModelCatalog: models.loadModelCatalog, loadSkills: skills.loadSkills,
    loadProjectPrompt: projectPrompt.load, canLeaveProjectPrompt: projectPrompt.canLeave, showError });
  const reading = createReadingSettings({ mount: el.readingTab, container: readingContainer, onNotice: showNotice });
  el.closeSettings.addEventListener('click', settings.close);
  for (const tab of el.settingsDialog.querySelectorAll('[data-settings-tab]'))
    tab.addEventListener('click', () => settings.activateTab(tab.dataset.settingsTab));
  el.providerConfigSelect.addEventListener('change', models.changeProviderConfig);
  el.modelConfigSelect.addEventListener('change', models.changeModelConfig);
  el.addProvider.addEventListener('click', models.addProviderConfig);
  el.deleteProvider.addEventListener('click', models.deleteProviderConfig);
  el.addModel.addEventListener('click', models.addModelConfig);
  el.duplicateModel.addEventListener('click', models.duplicateModelConfig);
  el.deleteModel.addEventListener('click', models.deleteModelConfig);
  el.reloadModelsConfig.addEventListener('click', models.loadModelsConfig);
  el.saveModelsConfig.addEventListener('click', models.saveModelsConfig);
  el.testModel.addEventListener('click', models.testConfiguredModel);
  el.defaultModelSelect.addEventListener('change', () => models.syncDefaultModelPreference());
  el.selectAllModels.addEventListener('click', () => models.updateModelVisibility('all'));
  el.invertModels.addEventListener('click', () => models.updateModelVisibility('invert'));
  el.savePreferences.addEventListener('click', models.saveModelPreferences);
  el.addSkillButton.addEventListener('click', () => {
    Object.assign(state.skills, { skillAdding: true, skillAddMode: 'market', skillMarketQuery: '', skillSearchResults: [] });
    skills.renderSkillDetail();
  });
  el.refreshSkills.addEventListener('click', () => skills.loadSkills());
  el.checkAllSkillUpdates.addEventListener('click', () => skills.checkSkillUpdates());
  el.skillsFilter.addEventListener('input', skills.renderSkillsList);
  el.closeSecret.addEventListener('click', auth.cancelSecretInput);
  el.cancelSecret.addEventListener('click', auth.cancelSecretInput);
  el.submitSecret.addEventListener('click', auth.submitSecretInput);
  return { models, auth, skills, projectPrompt, settings, reading };
}
