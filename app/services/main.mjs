import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeContext } from './runtime-context.mjs';
import { createCommands } from './commands/index.mjs';
import { publicErrorMessage } from '../shared/errors.js';
import { createEventChannel } from './event-channel.mjs';
import { MAX_PENDING_REQUESTS } from '../shared/commands.js';

const runId = process.env.SUPER_BAODAN_DESKTOP_RUN_ID;
if (!runId || typeof process.send !== 'function') throw new Error('应用服务只能由主进程启动');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = process.env.SUPER_BAODAN_DATA_DIR;
if (!dataRoot || !process.env.PI_CODING_AGENT_DIR) throw new Error('缺少受控数据目录');
let context, commands, closing = false, shutdownPromise;
const pending = new Map();
const send = (message, done = () => {}) => { if (process.connected) process.send({ ...message, runId }, done); else done(); };
const events = createEventChannel(send);

process.on('message', message => {
  if (!message || message.runId !== runId) return;
  if (message.type === 'shutdown') { void shutdown(); return; }
  if (message.type === 'cancel') { pending.get(message.id)?.controller.abort(); return; }
  if (message.type !== 'invoke' || typeof message.id !== 'string') return;
  if (closing || !commands || pending.has(message.id) || pending.size >= MAX_PENDING_REQUESTS) {
    send({ type: 'result', id: message.id, error: { code: 503, message: '应用服务暂不可用' } }); return;
  }
  const controller = new AbortController();
  const task = Promise.resolve().then(() => commands.invoke(message.name, message.args, controller.signal))
    .then(value => send({ type: 'result', id: message.id, value }), error => send({ type: 'result', id: message.id, error: { code: error.statusCode || 500, message: publicErrorMessage(error) } }))
    .finally(() => pending.delete(message.id));
  pending.set(message.id, { controller, task });
});
process.once('disconnect', () => { void shutdown(); setTimeout(() => process.exit(1), 5000).unref(); });
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  context = await createRuntimeContext({
    root, dataRoot, desktopControlled: true, desktopInstanceId: runId,
    holidayCacheDir: path.join(dataRoot, 'holiday-cache'),
    backupDir: path.join(dataRoot, 'backups'), workspaceDir: path.join(dataRoot, 'workspace'),
    todoFile: path.join(dataRoot, 'work-todo.md'),
    appScript: path.join(root, 'scripts/open-work-apps.ps1'),
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    piSessionDir: path.join(dataRoot, 'sessions'), vskillFile: path.join(dataRoot, 'vskills.json'),
    dailyRecordFile: path.join(dataRoot, 'daily-records.json'), workspaceFile: path.join(dataRoot, 'workspaces.json'),
    emitEvent: (topic, event) => events.push(topic, event),
  });
  commands = createCommands(context);
  if (closing) await shutdown();
  else send({ type: 'ready' });
} catch (error) {
  send({ type: 'startup-error', message: publicErrorMessage(error) });
  await context?.shutdown().catch(() => {});
  process.exit(1);
}

function shutdown() {
  closing = true;
  events.close();
  // Initialization must finish before tearing down its resources.
  if (!context) return Promise.resolve();
  if (shutdownPromise) return shutdownPromise;
  context.shuttingDown = true;
  shutdownPromise = (async () => {
    for (const { controller } of pending.values()) controller.abort();
    await Promise.allSettled([...pending.values()].map(item => item.task));
    await context.shutdown();
    send({ type: 'shutdown-complete' });
    process.exit(0);
  })().catch(error => send({ type: 'shutdown-error', message: publicErrorMessage(error) }));
  return shutdownPromise;
}
