import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentClient } from '../app/renderer/core/agent-client.js';
import { createSessionService } from '../app/renderer/core/session-service.js';
import { createHomeChat } from '../app/renderer/home/home-chat.js';
import { deferred } from './helpers/fake-sdk-host.mjs';

function harness() {
  const requests = []; let workspace = 'A';
  const request = (url, options) => { const gate = deferred(); requests.push({ url, options, ...gate }); return gate.promise; };
  const client = createAgentClient({ request, getWorkspaceId: () => workspace });
  const service = createSessionService({ request, agentClient: client, getWorkspaceId: () => workspace });
  function resolveSync(index, id) { requests[index].resolve({ data: { sessionId: id } }); requests[index + 1].resolve({ data: { messages: [{ role: 'user', content: id }] } }); }
  return { client, service, requests, resolveSync, workspace: id => { workspace = id; client.applyEvent({ type: 'workspace_changed', workspace: { id } }); } };
}

test('syncCurrent: overlapping syncs reject older state before apply and render', async () => {
  const h = harness(), first = h.service.syncCurrent(); first.catch(() => {});
  const second = h.service.syncCurrent(); h.resolveSync(2, 'new');
  const rendered = await second; assert.equal(rendered.current(), true);
  h.resolveSync(0, 'old'); await assert.rejects(first, { staleResponse: true });
  assert.equal(h.client.state().sessionId, 'new');
  const next = h.service.syncCurrent(); assert.equal(rendered.current(), false);
  h.resolveSync(4, 'newer'); await next;
});

for (const mutation of ['activate', 'create', 'remove']) test(`syncCurrent: same-workspace ${mutation} invalidates in-flight bootstrap and sync`, async () => {
  const h = harness();
  const bootstrap = h.client.bootstrap(); bootstrap.catch(() => {});
  const old = h.service.syncCurrent(); old.catch(() => {});
  const changing = h.service[mutation]('B.jsonl');
  h.requests[0].resolve({ workspace: { id: 'A' }, state: { sessionId: 'old' } });
  h.resolveSync(1, 'old');
  await assert.rejects(bootstrap, { staleResponse: true }); await assert.rejects(old, { staleResponse: true });
  const during = h.service.syncCurrent(); during.catch(() => {});
  h.requests[3].resolve({}); await changing;
  h.resolveSync(4, 'old'); await assert.rejects(during, { staleResponse: true });
  const fresh = h.service.syncCurrent(); h.resolveSync(6, 'B'); await fresh;
  assert.equal(h.client.state().sessionId, 'B');
});

test('syncCurrent: workspace A→B→A and lifecycle boundaries invalidate old reads', async () => {
  for (const change of [h => { h.workspace('B'); h.workspace('A'); }, h => { h.client.applyAgentState({ sessionId: 'A' }); h.client.applyEvent({ type: 'runtime_ready', state: { sessionId: 'B' } }); }, h => h.client.applyEvent({ type: 'agent_start' }), h => h.client.applyEvent({ type: 'agent_settled' })]) {
    const h = harness(), old = h.service.syncCurrent(); old.catch(() => {}); change(h);
    h.resolveSync(0, 'old'); await assert.rejects(old, { staleResponse: true });
    assert.notEqual(h.client.state().sessionId, 'old');
  }
});

test('bootstrap and snapshot share sync ordering, including after the await boundary', async () => {
  const h = harness();
  const first = h.service.syncCurrent(); first.catch(() => {});
  const bootstrap = h.client.bootstrap(); h.requests[2].resolve({ workspace: { id: 'A' }, state: { sessionId: 'B' } });
  const data = await bootstrap; h.resolveSync(0, 'old'); await assert.rejects(first, { staleResponse: true });
  const snapshot = h.client.getSnapshot({ messages: true }); assert.equal(h.client.bootstrapCurrent(data), false);
  h.requests[3].resolve({ state: { sessionId: 'B' }, messages: [] }); const result = await snapshot;
  assert.equal(result.current(), true);
  const synced = h.service.syncCurrent(); assert.equal(result.current(), false); h.resolveSync(4, 'B'); await synced;
  const stale = h.client.getSnapshot(); stale.catch(() => {}); h.workspace('C'); h.requests[6].resolve({ state: { sessionId: 'old' } });
  await assert.rejects(stale, { staleResponse: true });
});

const chatUrl = new URL('../app/renderer/assistant/chat-view.js', import.meta.url);
const source = (await readFile(chatUrl, 'utf8'))
  .replace(/^import \{ repairToolOutputEncoding \}.*$/m, 'const repairToolOutputEncoding = value => value;')
  .replace(/^import \{ createImageAttachments, readFileAsDataUrl \}.*$/m, 'const createImageAttachments = () => ({}); const readFileAsDataUrl = () => {};')
  .replace(/from (["'])(\.[^"']+)\1/g, (_m, _q, specifier) => `from ${JSON.stringify(new URL(specifier, chatUrl).href)}`);
const { createChatView } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('home and assistant reject stale sync immediately before render (no DOM/state writes)', async () => {
  for (const home of [true, false]) {
    const gate = deferred(), state = {}, messages = { addEventListener() {} };
    const service = { syncCurrent: () => gate.promise };
    const chat = home ? createHomeChat({ state, elements: { chatMessages: messages }, sessionService: service })
      : createChatView({ state, elements: { messages }, sessionService: service, getTurnFiles: () => ({ involved: [], modified: [] }), updateStateFromAgent() { assert.fail('stale state applied'); } });
    const pending = home ? chat.syncHomeChatMessages() : chat.syncMessagesFromAgent();
    gate.resolve({ state: { sessionId: 'old' }, messages: [{ role: 'user', content: 'old' }], current: () => false }); await pending;
    assert.equal(state.activeSessionId, undefined);
  }
});

test('bootstrap remains valid when first runtime_ready arrives during initial SDK startup', async () => {
  const h = harness(), loading = h.client.bootstrap();
  h.client.applyEvent({ type: 'runtime_ready', state: { sessionId: 'first' } });
  h.requests[0].resolve({ workspace: { id: 'A' }, state: { sessionId: 'first' }, messages: [] });
  assert.equal(h.client.bootstrapCurrent(await loading), true);
});

const flush = () => new Promise(setImmediate);
for (const firstFails of [false, true]) test(`session mutation queue: B→C cannot complete in reverse; first failure=${firstFails} does not poison latest refresh`, async () => {
  const h = harness(), b = h.service.activate('B'); b.catch(() => {});
  const c = h.service.activate('C');
  assert.deepEqual(h.requests.map(r => r.options.path), ['B']);
  if (firstFails) h.requests[0].reject(new Error('B failed')); else h.requests[0].resolve({ state: { sessionId: 'B' } });
  await assert.rejects(b, { staleResponse: true }); await flush();
  assert.deepEqual(h.requests.map(r => r.options.path), ['B', 'C']);
  h.requests[1].resolve({ state: { sessionId: 'C' } }); await c;
  const sync = h.service.syncCurrent(); h.resolveSync(2, 'C'); assert.equal((await sync).current(), true);
  assert.equal(h.client.state().sessionId, 'C');
});

test('queued session mutations are cancelled across workspace A→B→A, and new workspace operations still run', async () => {
  const h = harness(), b = h.service.activate('B'), c = h.service.activate('C'); b.catch(() => {}); c.catch(() => {});
  h.workspace('B'); h.workspace('A'); h.requests[0].resolve({});
  await assert.rejects(b, { staleResponse: true }); await assert.rejects(c, { staleResponse: true });
  assert.equal(h.requests.length, 1, 'C never sent into a different workspace generation');
  const next = h.service.create(); h.requests[1].resolve({}); await next;
  const sync = h.service.syncCurrent(); h.resolveSync(2, 'fresh'); await sync;
});

import { createSessionsView } from '../app/renderer/assistant/sessions-view.js';
import { chatConsumer, TestNode } from './helpers/chat-consumer.mjs';

test('sessions-view: latest C failure shows original error and reloads actual B after all transitions end', async () => {
  const h = harness(), errors = [], rendered = [], gates = [];
  const loading = async () => { const gate = h.client.bootstrap(); gates.push(gate); const data = await gate; if (h.client.bootstrapCurrent(data)) rendered.push(data.state.sessionId); };
  const view = createSessionsView({ state: {}, elements: { sessionSearch: new TestNode(), sessionSearchResults: new TestNode(), sessionList: new TestNode() }, sessionService: h.service, getRunning: () => false, loadBootstrap: loading, showError: error => errors.push(error.message) });
  const b = view.activateSession({ path: 'B' }), c = view.activateSession({ path: 'C' });
  h.requests[0].resolve({}); await b; await flush();
  h.requests[1].reject(new Error('C failed')); await flush();
  assert.deepEqual(errors, ['C failed']); assert.equal(gates.length, 1); assert.match(h.requests[2].url, /bootstrap/);
  h.requests[2].resolve({ workspace: { id: 'A' }, state: { sessionId: 'B' }, messages: [] }); await c;
  assert.deepEqual(rendered, ['B']);
});

for (const home of [true, false]) for (const readFails of [false, true]) test(`${home ? 'home' : 'assistant'} actual consumer: late recovery (failure=${readFails}) cannot clear new live content; token burst coalesces and quiet read restores full history`, async t => {
  const h = harness(), ui = chatConsumer(t, home, { client: h.client, service: h.service });
  t.after(() => ui.event({ type: 'runtime_stopping' }));
  ui.event({ type: 'tool_execution_update', snapshotRequired: true });
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.requests.length, 2);
  ui.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (let i = 0; i < 80; i++) ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new' } });
  ui.flushFrames();
  const live = home ? ui.state.liveAssistant : ui.state.live;
  if (readFails) { h.requests[0].reject(new Error('old request failed')); h.requests[1].resolve({ data: { messages: [] } }); }
  else h.resolveSync(0, 'OLD');
  await flush();
  assert.equal(home ? ui.state.liveAssistant : ui.state.live, live);
  assert.equal(home ? ui.state.liveText : ui.state.live.text, 'new'.repeat(80));
  assert.doesNotMatch(ui.messages.textContent, /OLD/);
  // Keep emitting beyond the quiet interval: no per-token retries or clears.
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 30)); ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '!' } }); }
  assert.equal(h.requests.length, 2);
  for (let i = 0; i < 2; i++) { await pause(); assert.equal(h.requests.length, 2, 'stale in-flight recovery waits for message end, not silence'); }
  assert.equal(home ? ui.state.liveAssistant : ui.state.live, live);
  ui.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'new complete' }] } });
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.requests.length, 4);
  h.requests[2].resolve({ data: { sessionId: 'current', isStreaming: false } });
  h.requests[3].resolve({ data: { messages: [{ role: 'user', content: 'full omitted history' }, { role: 'assistant', content: [{ type: 'text', text: 'new complete' }] }] } });
  await flush(); ui.flushFrames();
  assert.match(ui.messages.textContent, /full omitted history/); assert.match(ui.messages.textContent, /new complete/);
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.requests.length, 4, 'successful recovery stops retries');
});

test('home consumer: latest session failure retains original error and restores the actual preceding session', async t => {
  const h = harness(), ui = chatConsumer(t, true, { client: h.client, service: h.service });
  const b = ui.chat.activateHistorySession({ path: 'B' }), c = ui.chat.activateHistorySession({ path: 'C' });
  h.requests[0].resolve({}); await b; await flush(); h.requests[1].reject(new Error('C original error')); await flush();
  assert.deepEqual(ui.notices, ['C original error']); assert.match(h.requests[2].url, /bootstrap/);
  h.requests[2].resolve({ workspace: { id: 'A' }, state: { sessionId: 'B' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'actual B history' }] }] }); await c;
  assert.equal(ui.state.activeSessionId, 'B'); assert.match(ui.messages.textContent, /actual B history/);
});

test('sessions-view: deleting an inactive session after a superseded activation still refreshes final session/messages', async () => {
  const h = harness(), rendered = [], view = createSessionsView({ state: {}, elements: { sessionSearch: new TestNode(), sessionSearchResults: new TestNode(), sessionList: new TestNode() }, sessionService: h.service, getRunning: () => false, uiDialogs: { confirm: async () => true }, showNotice() {}, showError: error => { throw error; }, loadBootstrap: async () => { const data = await h.client.bootstrap(); if (h.client.bootstrapCurrent(data)) rendered.push(data.state.sessionId); } });
  const b = view.activateSession({ path: 'B' }), deletion = view.deleteSession({ path: 'unused', title: 'unused' }); await flush();
  h.requests[0].resolve({}); await b; await flush(); h.requests[1].resolve({ activeDeleted: false }); await flush();
  assert.match(h.requests[2].url, /bootstrap/); h.requests[2].resolve({ workspace: { id: 'A' }, state: { sessionId: 'B' }, messages: [] }); await deletion;
  assert.deepEqual(rendered, ['B']);
});

for (const home of [true, false]) test(`${home ? 'home' : 'assistant'} consumer: settlement supersedes an in-flight recovery and leaves one final full render`, async t => {
  const h = harness(), ui = chatConsumer(t, home, { client: h.client, service: h.service });
  t.after(() => ui.event({ type: 'runtime_stopping' }));
  ui.event({ type: 'tool_execution_update', snapshotRequired: true }); await new Promise(resolve => setTimeout(resolve, 180));
  ui.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final SSE' }] } });
  const count = home ? 4 : 5;
  ui.event({ type: 'agent_settled' }); assert.equal(h.requests.length, count);
  h.requests[2].resolve({ data: { sessionId: 'final', isStreaming: false } }); h.requests[3].resolve({ data: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final complete history' }] }] } });
  if (!home) h.requests[4].resolve({ sessions: [] });
  await flush(); h.resolveSync(0, 'obsolete'); await flush(); ui.flushFrames();
  assert.match(ui.messages.textContent, /final complete history/); assert.doesNotMatch(ui.messages.textContent, /obsolete/);
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.requests.length, count);
});

const pause = () => new Promise(resolve => setTimeout(resolve, 200));
for (const home of [true, false]) for (const dirtyBeforeStart of [true, false]) test(`${home ? 'home' : 'assistant'} consumer: unfinished message (dirty before start=${dirtyBeforeStart}) survives quiet periods and shared history renders until completion`, async t => {
  const h = harness(), ui = chatConsumer(t, home, { client: h.client, service: h.service });
  t.after(() => ui.event({ type: 'runtime_stopping' }));
  const omitted = () => ui.event({ type: 'tool_execution_update', snapshotRequired: true });
  if (dirtyBeforeStart) omitted();
  ui.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PARTIAL' } });
  if (!dirtyBeforeStart) omitted();
  ui.flushFrames();
  const live = home ? ui.state.liveAssistant : ui.state.live, dom = ui.messages.textContent;
  const assertLive = () => {
    assert.equal(home ? ui.state.liveAssistant : ui.state.live, live);
    assert.equal(home ? ui.state.liveText : ui.state.live.text, 'PARTIAL');
    assert.equal(ui.messages.textContent, dom);
  };
  // Silence is not message completion. No recovery requests across three windows.
  for (let i = 0; i < 3; i++) { await pause(); assertLive(); assert.equal(h.requests.length, 0); }
  const history = [{ role: 'user', content: 'history without streamingMessage' }];
  // A separate explicit sync begun AFTER the delta has a valid read ticket.
  const syncing = home ? ui.chat.syncHomeChatMessages() : ui.chat.syncMessagesFromAgent();
  h.requests[0].resolve({ data: { sessionId: 'current', isStreaming: true } });
  h.requests[1].resolve({ data: { messages: history } }); await syncing; ui.flushFrames(); assertLive();
  // Home's actual bootstrap and assistant's shared bootstrap/fallback render entry.
  const bootstrap = home ? ui.chat.loadHomeChatBootstrap() : h.client.bootstrap();
  h.requests[2].resolve({ workspace: { id: 'A' }, state: { sessionId: 'current', isStreaming: true }, messages: history });
  const data = await bootstrap;
  if (!home) { assert.equal(h.client.bootstrapCurrent(data), true); ui.chat.renderMessages(data.messages); }
  ui.flushFrames(); assertLive(); await pause(); assert.equal(h.requests.length, 3, 'blocked renders do not start polling');
  if (dirtyBeforeStart) ui.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PARTIAL complete' }] } });
  else ui.event({ type: 'agent_settled' }); // Abort/settlement need not send a final message_end.
  await pause();
  const count = !dirtyBeforeStart && !home ? 6 : 5;
  assert.equal(h.requests.length, count);
  h.requests[3].resolve({ data: { sessionId: 'current', isStreaming: false } });
  h.requests[4].resolve({ data: { messages: [...history, { role: 'assistant', content: [{ type: 'text', text: 'PARTIAL complete' }] }] } });
  if (count === 6) h.requests[5].resolve({ sessions: [] });
  await flush(); ui.flushFrames(); assert.match(ui.messages.textContent, /history without streamingMessage/); assert.match(ui.messages.textContent, /PARTIAL complete/);
  await pause(); assert.equal(h.requests.length, count, 'one final recovery, no further polling');
});

for (const home of [true, false]) for (const boundary of ['runtime_stopping', 'workspace', 'session']) test(`${home ? 'home' : 'assistant'} consumer: ${boundary} resets unfinished-message recovery without retaining old live in a new history`, async t => {
  const h = harness(), ui = chatConsumer(t, home, { client: h.client, service: h.service });
  t.after(() => ui.event({ type: 'runtime_stopping' }));
  ui.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'OLD LIVE' }, snapshotRequired: true });
  ui.flushFrames(); assert.ok(home ? ui.state.liveAssistant : ui.state.live);
  if (boundary === 'workspace') h.workspace('B');
  else if (boundary === 'session') h.client.beginTransition()();
  else ui.event({ type: boundary });
  await pause(); assert.equal(h.requests.length, 0, 'old dirty work is discarded without polling');
  const sync = home ? ui.chat.syncHomeChatMessages() : ui.chat.syncMessagesFromAgent();
  h.requests[0].resolve({ data: { sessionId: 'new context', isStreaming: false } });
  h.requests[1].resolve({ data: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'NEW HISTORY' }] }] } });
  await sync; ui.flushFrames(); assert.match(ui.messages.textContent, /NEW HISTORY/); assert.doesNotMatch(ui.messages.textContent, /OLD LIVE/);
  assert.equal(home ? ui.state.liveAssistant : ui.state.live, null);
  await pause(); assert.equal(h.requests.length, 2);
});

for (const home of [true, false]) for (const boundary of ['workspace', 'session']) test(`${home ? 'home' : 'assistant'} consumer: new live before ${boundary} bootstrap never reuses old live or its queued frame`, async t => {
  const h = harness(), ui = chatConsumer(t, home, { client: h.client, service: h.service });
  t.after(() => ui.event({ type: 'runtime_stopping' }));
  ui.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'OLD LIVE' } });
  const oldLive = home ? ui.state.liveAssistant : ui.state.live, oldNode = home ? oldLive : oldLive.node;
  const oldBootstrap = home ? ui.chat.loadHomeChatBootstrap() : h.client.bootstrap(); oldBootstrap.catch(() => {});
  if (boundary === 'workspace') h.workspace('B'); else h.client.beginTransition()();
  ui.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'NEW' } });
  const newLive = home ? ui.state.liveAssistant : ui.state.live;
  assert.notEqual(newLive, oldLive); assert.equal(oldNode.isConnected, false);
  ui.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' CONTINUED' } });
  ui.flushFrames(); assert.equal(home ? ui.state.liveAssistant : ui.state.live, newLive);
  assert.equal(home ? ui.state.liveText : ui.state.live.text, 'NEW CONTINUED'); assert.doesNotMatch(ui.messages.textContent, /OLD/);
  h.requests[0].resolve({ workspace: { id: 'A' }, state: { sessionId: 'old' }, messages: [{ role: 'user', content: 'OLD BOOTSTRAP' }] });
  if (home) await oldBootstrap; else await assert.rejects(oldBootstrap, { staleResponse: true });
  assert.equal(home ? ui.state.liveAssistant : ui.state.live, newLive); assert.doesNotMatch(ui.messages.textContent, /OLD/);
  ui.event({ type: 'tool_execution_update', snapshotRequired: true }); await pause(); assert.equal(h.requests.length, 1);
  ui.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'NEW COMPLETE' }] } });
  await pause(); assert.equal(h.requests.length, 3);
  h.requests[1].resolve({ data: { sessionId: 'new', isStreaming: false } });
  h.requests[2].resolve({ data: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'NEW COMPLETE' }] }] } });
  await flush(); ui.flushFrames(); assert.match(ui.messages.textContent, /NEW COMPLETE/); assert.doesNotMatch(ui.messages.textContent, /OLD/);
});
