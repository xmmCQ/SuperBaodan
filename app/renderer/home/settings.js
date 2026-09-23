import { createSettingsPanel } from '../assistant/settings-panel.js';
import { createAssistantState } from '../assistant/state.js';
import { createUiDialogController } from '../ui-dialog.js';
import { renderMarkdown, markdownBodyWithoutFrontmatter } from '../markdown-renderer.js';

// Mount only the shared dialogs, never start/navigate to the assistant workspace.
// A shadow root isolates their existing styles and IDs from the home page.
export function createHomeSettings({ trigger, elements, invoke, agentClient, getWorkspace,
  loadBootstrap, reading, showNotice, onCatalogChanged }) {
  let panel, pending, opening = false;
  const showError = error => panel ? panel.settings.toast(error.message || String(error), 'error') : showNotice(error.message || String(error), true);
  async function initialize() {
    const response = await fetch('/assistant.html');
    if (!response.ok) throw new Error('设置界面加载失败，请重试');
    const template = new DOMParser().parseFromString(await response.text(), 'text/html');
    const stylesheets = [...template.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href'));
    stylesheets.push('/home/settings-theme.css');
    const styles = await Promise.all(stylesheets.map(async href => {
      const response = await fetch(href);
      if (!response.ok) throw new Error('设置样式加载失败，请重试');
      return (await response.text()).replaceAll(':root', ':host').replace(/(^|\n)body(?=\s*\{)/g, '$1:host');
    }));
    const host = document.createElement('div'); host.id = 'homeSettingsHost'; host.style.display = 'contents';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = styles.join('\n'); root.append(style);
    const wrapper = document.createElement('div'); wrapper.className = 'assistant-page'; wrapper.style.display = 'contents'; root.append(wrapper);
    for (const id of ['settingsDialog', 'secretDialog', 'uiDialog']) {
      const dialog = template.getElementById(id);
      if (!dialog) throw new Error('设置界面不完整，请重试');
      wrapper.append(document.importNode(dialog, true));
    }
    document.body.append(host);
    try {
      const el = { ...elements, ...Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id, node])) };
      const uiDialogs = createUiDialogController({ dialog: el.uiDialog, form: el.uiDialogForm,
        title: el.uiDialogTitle, message: el.uiDialogMessage, field: el.uiDialogField,
        closeButton: el.uiDialogClose, cancelButton: el.uiDialogCancel, confirmButton: el.uiDialogConfirm });
      panel = createSettingsPanel({ state: createAssistantState(), elements: el, invoke,
        command: agentClient.command, uiDialogs, showNotice, showError, loadBootstrap,
        updateStateFromAgent: data => panel.models.applyAgentState(data), captureContext: agentClient.captureContext, capturePreferences: agentClient.captureWorkspace,
        renderMarkdown, markdownBodyWithoutFrontmatter, getWorkspace, readingContainer: elements.chatMessages, onCatalogChanged });
      reading.dispose();
      el.settingsDialog.addEventListener('close', () => trigger.focus({ preventScroll: true }));
      return panel;
    } catch (error) { host.remove(); throw error; }
  }
  async function open() {
    if (opening) return;
    opening = true; trigger.disabled = true;
    try {
      pending ||= initialize().catch(error => { pending = null; throw error; });
      await pending;
      await panel.settings.open();
    } catch (error) { showError(error); }
    finally { opening = false; trigger.disabled = false; }
  }
  return { open, hasDraft: () => Boolean(panel?.projectPrompt.hasDraft()),
    syncModels: () => panel?.models.syncModelCatalog(), discard: () => panel?.projectPrompt.discard(), contextChanged: () => panel?.projectPrompt.contextChanged() };
}
