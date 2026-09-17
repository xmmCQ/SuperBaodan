import { readFile } from 'node:fs/promises';
import { createHomeChat } from '../../app/renderer/home/home-chat.js';

// Small DOM surface for exercising the actual chat state/render consumers, not
// layout. Layout dependencies are stubbed; chat functions execute unchanged.
export class TestNode {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this.value = ''; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this._text = ''; }
  get classList() { return { contains: value => this.className.split(' ').includes(value), add: value => { this.className += ` ${value}`; }, remove: value => { this.className = this.className.split(' ').filter(x => x !== value).join(' '); }, toggle: (value, on) => { on ? this.classList.add(value) : this.classList.remove(value); } }; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.textContent = value; }
  get childElementCount() { return this.children.length; }
  get isConnected() { return Boolean(this.parent); }
  append(...nodes) { for (const node of nodes) { if (node.tag === '#fragment') this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
  replaceWith(node) { const parent = this.parent; if (!parent) return; parent.children[parent.children.indexOf(this)] = node; node.parent = parent; this.parent = null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  querySelectorAll(selector) { const name = selector.split('.').at(-1); const all = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]); return selector === '*' ? all : all.filter(node => selector.startsWith('.') ? node.classList.contains(name) : node.tag === selector); }
  querySelector(selector) { if (selector.startsWith(':scope > .')) return this.children.find(node => node.classList.contains(selector.slice(10))) || null; return this.querySelectorAll(selector)[0] || null; }
  closest() { return this.parent || this; }
  addEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  scrollTo({ top }) { this.scrollTop = top; }
}

async function isolatedModule(path, imports) {
  const url = new URL(path, import.meta.url); let source = await readFile(url, 'utf8');
  for (const [pattern, replacement] of imports) source = source.replace(pattern, replacement);
  source = source.replace(/from (["'])(\.[^"']+)\1/g, (_m, _q, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { createChatView } = await isolatedModule('../../app/renderer/assistant/chat-view.js', [
  [/^import \{ repairToolOutputEncoding \}.*$/m, 'const repairToolOutputEncoding = value => value;'],
  [/^import \{ createImageAttachments, readFileAsDataUrl \}.*$/m, 'const createImageAttachments = () => ({ clear() {} }); const readFileAsDataUrl = () => {};'],
]);
const { createWorkspaceController } = await isolatedModule('../../app/renderer/assistant/workspace-controller.js', [
  [/^import \{ createFileTabs \}.*$/m, 'const createFileTabs = () => ({});'],
  [/^import \{ createWorkspacePanel \}.*$/m, 'const createWorkspacePanel = () => ({});'],
  [/^import \{ createSidebarResize \}.*$/m, 'const createSidebarResize = () => {};'],
]);
const mainSource = await readFile(new URL('../../app/renderer/assistant/main.js', import.meta.url), 'utf8');
const handlerSource = mainSource.slice(mainSource.indexOf('function handleAgentEvent('), mainSource.indexOf('\nfunction updateStateFromAgent('));
const refreshSource = mainSource.slice(mainSource.indexOf('async function refreshStateAndSessions('), mainSource.indexOf('\nasync function shutdownWorkbench('));

export function chatConsumer(t, home, { client, service }) {
  const old = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map(); let id = 0;
  globalThis.document = { createElement: tag => new TestNode(tag), createDocumentFragment: () => new TestNode('#fragment'), querySelector: () => new TestNode() };
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = key => frames.delete(key);
  t.after(() => Object.assign(globalThis, old));
  const elements = new Proxy({}, { get(target, key) { return target[key] ||= new TestNode(); } });
  elements.chatHistoryDrawer.className = 'hidden';
  const state = { liveText: '', activeTools: new Map(), images: [], running: false }, fileState = { turnFiles: { involved: [], modified: [] } };
  const workspace = createWorkspaceController({ state: fileState, elements }), notices = [];
  workspace.refreshWorkspaceTreeIfOpen = async () => {};
  const options = { state, elements, agentClient: client, sessionService: service, renderMarkdown: (node, text) => { node.textContent = text; }, toast: message => notices.push(message), showNotice() {}, showError(error) { throw error; }, loadingState: () => 'loading', emptyState: () => 'empty', escapeHtml: value => value, uiDialogs: { confirm: async () => true }, getTurnFiles: workspace.turnFiles, setTurnFiles: workspace.setTurnFiles, updateStateFromAgent: value => { state.running = Boolean(value.isStreaming); }, workspaceSwitcher: { active: () => ({ id: 'A' }), sync() {} } };
  const chat = home ? createHomeChat(options) : createChatView(options);
  const event = home ? chat.handleHomeChatEvent : new Function('agentClient', 'chat', 'workspace', 'execution', 'sessionService', 'sessions', 'updateStateFromAgent', 'showNotice', `${refreshSource}\nreturn ${handlerSource}`)(client, chat, workspace, { event() {} }, service, { renderSessions() {} }, options.updateStateFromAgent, () => {});
  return { chat, event, state, workspace, elements, notices, messages: home ? elements.chatMessages : elements.messages, flushFrames() { for (let i = 0; frames.size && i < 10; i++) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); } } };
}
