// HTTP exists only in this test adapter, so existing domain integration fixtures
// can exercise the new command handlers without loading Electron.
import http from 'node:http';
import { createCommands } from '../../app/services/commands/index.mjs';
import { FIXTURE_OPERATIONS } from './fixture-operations.mjs';

export function createServerApplication(context) {
  const commands = createCommands(context);
  const routes = Object.entries(FIXTURE_OPERATIONS).map(([name, spec]) => {
    const [method, pattern] = spec.split(' ');
    return { name, method: method.toUpperCase(), regex: new RegExp('^'+pattern.replace(':id','([^/]+)')+'$') };
  });
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const url = new URL(req.url, 'http://fixture');
      const route = routes.find(r => r.method === req.method && r.regex.test(url.pathname));
      if (!route) throw Object.assign(new Error('未知测试操作'), { statusCode: 404 });
      const match = url.pathname.match(route.regex);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = route.name === 'files.upload' ? { content: bytes } : bytes.length ? JSON.parse(bytes.toString()) : {};
      const args = { ...Object.fromEntries(url.searchParams), ...body, ...(match[1] ? { id: decodeURIComponent(match[1]) } : {}) };
      if (route.name === 'files.upload') args.overwrite = args.overwrite === 'true';
      const value = await commands.invoke(route.name, args, abort.signal);
      const status = ['records.create', 'tasks.create', 'agent.new', 'workspaces.add', 'files.upload'].includes(route.name) ? 201 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  context.attachServer?.(server);
  return server;
}
