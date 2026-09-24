import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UiEventPayloads } from '../app/services/ui-event-payloads.mjs';
import { createAgentEventStream } from '../app/renderer/core/event-stream.js';
import { createAgentContext, agentCommands } from './helpers/agent-context.mjs';
import { createServerApplication as createCommandFixture } from './helpers/command-http-fixture.mjs';
const createServerApplication = context => createCommandFixture(context,agentCommands(context));
import { MAX_BROWSER_EVENT_BYTES } from '../app/services/domain/pi-sdk-ui.mjs';
import { sdkHarness, deferred, wait } from './helpers/fake-sdk-host.mjs';

class Response extends EventEmitter {
  destroyed = false; writableLength = 0; chunks = [];
  constructor(block = false) { super(); this.block = block; }
  writeHead() {}
  write(chunk) { this.chunks.push(chunk); if (this.block) this.writableLength += Buffer.byteLength(chunk); return !this.block; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

async function contextHarness(t, { start = true, ...options } = {}) {
  const h = await sdkHarness(options);
  const c = await createAgentContext({ workspaceDir: h.temp.resolve('workspace'), piAgentDir: h.temp.resolve('agent'), piSessionDir: h.temp.resolve('sessions'), backupDir: h.temp.resolve('backups'), todoFile: h.temp.resolve('todo.md'), vskillFile: h.temp.resolve('vskills.json'), dailyRecordFile: h.temp.resolve('records.json'), workspaceFile: h.temp.resolve('workspaces.json'), host: '127.0.0.1', port: 0 },{createRuntime:()=>h.runtime,emit:(topic,event)=>c?.emitEvent?.(topic,event)});
  const sinks = [];
  c.emitEvent = (topic, event) => { if (topic === 'agent') for (const sink of sinks) sink.write(`data: ${JSON.stringify(event)}\n\n`); };
  c.captureEvents = (_unused, sink) => { sinks.push(sink); for (const event of [{type:'connected',workspace:c.activeWorkspace},...c.status().pendingUi]) sink.write(`data: ${JSON.stringify(event)}\n\n`); };

  t.after(async () => { c.uiEventPayloads.clear(); c.piAdmin.close(); await h.cleanup(); });
  if (start) await h.runtime.start();
  return { h, c };
}

test('real SDK subscription→runtime→SSE adapts image/long messages and terminal tool/agent events; snapshot restores full body', async t => {
  const { h, c } = await contextHarness(t), fast = new Response(), slow = new Response(true);
  c.captureEvents(new EventEmitter(), fast); c.captureEvents(new EventEmitter(), slow);
  const large = '中文正文'.repeat(100000), image = 'a'.repeat(6 * 1024 * 1024);
  const user = { role: 'user', content: [{ type: 'image', data: image, mimeType: 'image/png' }] };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: large }] };
  h.hosts[0].session.messages.push(user, assistant);
  const events = [
    { type: 'message_start', message: user }, { type: 'message_end', message: user },
    { type: 'message_start', message: assistant },
    { type: 'message_update', message: assistant, assistantMessageEvent: { type: 'text_end', content: large, partial: assistant } },
    { type: 'message_end', message: assistant },
    { type: 'tool_execution_start', toolCallId: 'call', toolName: 'write', args: { path: 'file.txt', content: large } },
    { type: 'tool_execution_update', toolCallId: 'call', toolName: 'write', partialResult: { content: large } },
    { type: 'tool_execution_end', toolCallId: 'call', toolName: 'write', isError: false, result: { content: large } },
    { type: 'agent_end', messages: [user, assistant], willRetry: false }, { type: 'agent_settled' },
  ];
  for (const event of events) h.hosts[0].push(event);
  assert.equal(fast.destroyed, false);
  for (const chunk of fast.chunks) assert.ok(Buffer.byteLength(chunk) <= MAX_BROWSER_EVENT_BYTES + 8);
  const received = fast.chunks.map(chunk => JSON.parse(chunk.slice(6)));
  for (const event of events) assert.ok(received.some(item => item.type === event.type));
  assert.equal(received.find(item => item.type === 'tool_execution_end').isError, false);
  assert.equal(received.find(item => item.type === 'agent_end').willRetry, false);
  assert.equal(received.find(item => item.type === 'message_end').snapshotRequired, true);
  const snapshot = h.runtime.snapshot({ messages: true }); assert.deepEqual(snapshot.messages, [user, assistant]);
  // Ordinary bounded events still overwhelm only the stalled client.
  for (let i = 0; i < 40; i++) h.hosts[0].push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(10000) } });
  assert.equal(fast.destroyed, false);
});

test('large UI uses authenticated local retrieval, two clients retrieve identical full body, stale tokens fail', async t => {
  const { h, c } = await contextHarness(t), first = new Response(), second = new Response();
  c.captureEvents(new EventEmitter(), first); c.captureEvents(new EventEmitter(), second);
  const prefill = '完整编辑正文'.repeat(30000), answer = h.runtime.uiBridge.ui.editor('large', prefill);
  const reference = JSON.parse(first.chunks.at(-1).slice(6));
  assert.equal(reference.type, 'extension_ui_payload'); assert.deepEqual(JSON.parse(second.chunks.at(-1).slice(6)), reference);
  assert.equal(first.destroyed, false);
  const server = createServerApplication(c); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); c.config.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${c.config.port}`, url = `${base}/api/agent/ui-payload?token=${reference.token}&workspaceId=${reference.workspaceId}`;
  const results = await Promise.all([fetch(url), fetch(url)]);
  for (const result of results) { assert.equal(result.status, 200); const event = await result.json(); assert.equal(event.prefill, prefill); assert.equal(event.method, 'editor'); }
  assert.equal((await fetch(url.replace(reference.token, 'unknown'))).status, 410);
  c.workspaceEpoch += 1; assert.equal((await fetch(url)).status, 410);
  h.runtime.uiBridge.respond({ id: h.runtime.pendingUiRequests()[0].id, cancelled: true }); assert.equal(await answer, undefined);
});

test('UI payload capacity/TTL cancel pending questions, do not consume on read, and invalidate on rebind', async () => {
  const failures = [], requests = [{ id: 'question', type: 'extension_ui_request', method: 'editor', prefill: 'x'.repeat(100) }], cancelled = [];
  const runtime = { pendingUiRequests: () => requests, uiBridge: { respond: response => cancelled.push(response.id) } };
  const store = new UiEventPayloads({ maxItemBytes: 400, maxBytes: 400, maxItems: 1, ttlMs: 10, onFailure: event => failures.push(event) });
  try {
    const ref = store.put(requests[0], runtime, 1, 'A');
    assert.deepEqual(store.get(ref.token, runtime, 1, 'A'), requests[0]); assert.deepEqual(store.get(ref.token, runtime, 1, 'A'), requests[0]);
    const full = store.put({ ...requests[0], id: 'overflow' }, runtime, 1, 'A'); assert.equal(full.type, 'extension_error'); assert.ok(cancelled.includes('overflow'));
    await wait(30); assert.throws(() => store.get(ref.token, runtime, 1, 'A'), { statusCode: 410 }); assert.ok(cancelled.includes('question')); assert.equal(failures.length, 1); assert.equal(store.bytes, 0);
    const fresh = store.put(requests[0], runtime, 1, 'A'); runtime.uiBridge = {};
    assert.throws(() => store.get(fresh.token, runtime, 1, 'A'), { statusCode: 410 });
  } finally { store.clear(); }
});

function browserStream(request) {
  const events = [], source = { close() {} };
  const stream = createAgentEventStream({ request: (name, ...args) => name === 'agent.connect' ? Promise.resolve([]) : request(name, ...args), onEvent: event => events.push(event), bridge: fakeBridge(source) });
  stream.connect(); return { events, stream, send: event => source.onmessage({ data: JSON.stringify(event) }) };
}
const flush = () => new Promise(setImmediate);
test('UI retrieval dispatches in order; failure and workspace change never strand later events or apply stale UI', async () => {
  for (const outcome of ['success', 'failure', 'switch']) {
    const gate = deferred(), browser = browserStream(() => gate.promise);
    browser.send({ type: 'extension_ui_payload', token: 'random', workspaceId: 'A' }); browser.send({ type: 'agent_settled' });
    assert.deepEqual(browser.events, []);
    if (outcome === 'switch') browser.send({ type: 'workspace_changed', workspace: { id: 'B' } });
    if (outcome === 'failure') gate.reject(new Error('410 expired')); else gate.resolve({ type: 'extension_ui_request', prefill: 'full body' });
    await flush();
    assert.deepEqual(browser.events.map(event => event.type), outcome === 'switch' ? ['workspace_changed'] : [outcome === 'failure' ? 'extension_error' : 'extension_ui_request', 'agent_settled']);
    browser.send({ type: 'agent_start' }); assert.equal(browser.events.at(-1).type, 'agent_start'); browser.stream.close();
  }
});

test('large startup editor unblocks SDK initialization; notifications/editor text/select remain lossless', async t => {
  const large = '完整内容'.repeat(30000);
  const { h, c } = await contextHarness(t, { start: false, bind: async (_session, bindings) => {
    assert.equal(await bindings.uiContext.editor('startup', large), 'accepted');
  } });
  const fast = new Response(); c.captureEvents(new EventEmitter(), fast);
  const starting = h.runtime.ensureStarted();
  while (!h.runtime.pendingUiRequests().length) await wait(1);
  const fetchLatest = () => {
    const ref = JSON.parse(fast.chunks.at(-1).slice(6)); assert.equal(ref.type, 'extension_ui_payload');
    return c.uiEventPayloads.get(ref.token, h.runtime, c.workspaceEpoch, c.activeWorkspace.id);
  };
  const request = fetchLatest(); assert.equal(request.prefill, large);
  await h.runtime.send({ type: 'extension_ui_response', id: request.id, value: 'accepted' }); await starting;
  h.runtime.uiBridge.ui.notify(large, 'info'); assert.equal(fetchLatest().message, large);
  h.runtime.uiBridge.ui.setEditorText(large); assert.equal(fetchLatest().text, large);
  const selecting = h.runtime.uiBridge.ui.select('choose', [large, 'short']); const select = fetchLatest();
  assert.deepEqual(select.options, [large, 'short']); h.runtime.uiBridge.respond({ id: select.id, value: large }); assert.equal(await selecting, large);
  await h.runtime.stop(); assert.equal(c.uiEventPayloads.items.size, 0); assert.equal(fast.destroyed, false);
});

test('local session transition drops a late UI response and its old trailing events without blocking fresh events', async () => {
  const gate = deferred(), events = [], source = { close() {} }; let current = true;
  const stream = createAgentEventStream({ request: name => name === 'agent.connect' ? Promise.resolve([]) : gate.promise, captureContext: () => () => current, onEvent: event => events.push(event), bridge: fakeBridge(source) });
  stream.connect(); const send = event => source.onmessage({ data: JSON.stringify(event) });
  send({ type: 'extension_ui_payload', token: 'old', workspaceId: 'A' }); send({ type: 'agent_settled' }); current = false;
  gate.resolve({ type: 'extension_ui_request', prefill: 'old session' }); await flush(); assert.deepEqual(events, []);
  send({ type: 'runtime_ready', state: { sessionId: 'new' } }); assert.equal(events.length, 1); stream.close();
});

test('large UI HTTP retrieval→editor/select response accepts full escaped values; response and other command caps remain bounded', async t => {
  const { h, c } = await contextHarness(t), fast = new Response();
  c.captureEvents(new EventEmitter(), fast);
  const server = createServerApplication(c); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); c.config.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${c.config.port}`;
  const post = body => fetch(`${base}/api/agent/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ ...body, workspaceId: c.activeWorkspace.id }) });
  const large = '正文"\n\\'.repeat(200000);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 2 * 1024 * 1024);
  for (const method of ['editor', 'select']) {
    const answer = method === 'editor' ? h.runtime.uiBridge.ui.editor('large', large) : h.runtime.uiBridge.ui.select('large', [large, 'short']);
    const reference = JSON.parse(fast.chunks.at(-1).slice(6));
    const fetched = await fetch(`${base}/api/agent/ui-payload?token=${reference.token}&workspaceId=${reference.workspaceId}`);
    assert.equal(fetched.status, 200); const event = await fetched.json();
    const value = method === 'editor' ? event.prefill : event.options[0]; assert.equal(value, large);
    const result = await post({ type: 'extension_ui_response', id: event.id, value });
    assert.equal(result.status, 200); assert.equal(await answer, large); assert.equal(h.runtime.pendingUiRequests().length, 0);
  }
  const answer = h.runtime.uiBridge.ui.editor('bounded', 'small'), id = h.runtime.pendingUiRequests()[0].id;
  assert.equal((await post({ type: 'extension_ui_response', id, value: 'x'.repeat(4 * 1024 * 1024 + 16 * 1024) })).status, 413);
  assert.equal(h.runtime.pendingUiRequests().length, 1);
  assert.equal((await post({ type: 'get_state', padding: large })).status, 413);
  assert.equal((await post({ type: 'extension_ui_response', id, cancelled: true })).status, 200); assert.equal(await answer, undefined);
});

import { createAgentClient } from '../app/renderer/core/agent-client.js';
import { createSessionService } from '../app/renderer/core/session-service.js';
import { chatConsumer } from './helpers/chat-consumer.mjs';

test('oversized workspace_turn_files: real HTTP snapshots restore full consumer/card sets, omitted fields do not clear, old-turn reads never attach', async t => {
  const { h, c } = await contextHarness(t), fast = new Response(); c.captureEvents(new EventEmitter(), fast);
  const server = createServerApplication(c); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); c.config.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${c.config.port}`, delayed = deferred(), started = deferred(); let hold = true;
  const commands = (await import('../app/services/commands/index.mjs')).createCommands(c);
  const request = async (name, args) => {
    const body = await commands.invoke(name, args);
    if (name === 'agent.command' && args.type === 'get_messages' && hold) { hold = false; started.resolve(); await delayed.promise; }
    return body;
  };
  const getWorkspaceId = () => c.activeWorkspace.id, client = createAgentClient({ request, getWorkspaceId });
  const service = createSessionService({ request, getWorkspaceId, agentClient: client }), ui = chatConsumer(t, false, { client, service });
  t.after(() => { delayed.resolve(); ui.chat.stopResponseFallback(); ui.event({ type: 'runtime_stopping' }); });
  const paths = prefix => Array.from({ length: 400 }, (_, i) => `${prefix}/${String(i).padStart(4, '0')}-${'长路径'.repeat(25)}.txt`);
  const oldPaths = paths('old-turn'), newPaths = paths('new-turn');
  h.hosts[0].session.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'old response' }] });
  function emitFiles(involved, modified) {
    c.turnFiles.involved = new Set(involved); c.turnFiles.modified = new Set(modified);
    c.emitAgentEvent({ type: 'workspace_turn_files', ...c.turnFileSnapshot() });
    const event = JSON.parse(fast.chunks.at(-1).slice(6)); ui.event(event); return event;
  }
  ui.workspace.setTurnFiles({ involved: ['known.txt'], modified: ['known.txt'] });
  const compact = emitFiles(oldPaths, oldPaths.slice(0, 200));
  assert.equal(compact.snapshotRequired, true); assert.equal(compact.involved, undefined); assert.equal(fast.destroyed, false);
  assert.deepEqual(ui.workspace.turnFiles(), { involved: ['known.txt'], modified: ['known.txt'] });
  await started.promise;
  const snapshot = await fetch(`${base}/api/agent/snapshot?messages=1&workspaceId=${c.activeWorkspace.id}`).then(r => r.json());
  assert.deepEqual(snapshot.turnFiles, { involved: oldPaths, modified: oldPaths.slice(0, 200) });
  ui.event({ type: 'agent_start' }); emitFiles([], []);
  h.hosts[0].session.messages.splice(0, Infinity, { role: 'assistant', content: [{ type: 'text', text: 'new response' }] });
  emitFiles(newPaths, newPaths.slice(100, 300));
  delayed.resolve(); await wait(20);
  assert.deepEqual(ui.workspace.turnFiles(), { involved: [], modified: [] }, 'old-turn HTTP snapshot rejected before files/cards');
  for (let i = 0; i < 100 && !ui.workspace.turnFiles().involved.length; i++) await wait(10);
  assert.deepEqual(ui.workspace.turnFiles(), { involved: newPaths, modified: newPaths.slice(100, 300) });
  ui.flushFrames(); assert.match(ui.messages.textContent, /new response/); assert.doesNotMatch(ui.messages.textContent, /old-turn|old response/);
  assert.match(ui.messages.textContent, /new-turn/); assert.equal(ui.elements.turnFiles.querySelectorAll('button').length, 400);
});

function fakeBridge(source) {
  return { onEvent(fn) { source.onmessage = m => fn({ topic: 'agent', event: JSON.parse(m.data) }); return () => source.close(); }, onBackendStatus() { return () => {}; } };
}
