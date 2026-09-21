import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';

export const APP_ORIGIN = 'app://workbench';
export function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.hostname === 'workbench' && !url.port && !url.username && !url.password; }
  catch { return false; }
}

export function createResourceHandler({ root, service }) {
  return async request => {
    try {
      if (!isAppUrl(request.url) || request.method !== 'GET') return new Response(null, { status: 403 });
      const url = new URL(request.url);
      if (url.pathname === '/content') {
        const result = await service.invoke('files.content', Object.fromEntries(url.searchParams), { signal: request.signal });
        return new Response(new Uint8Array(result.content), { headers: { 'Content-Type': result.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const shared = url.pathname.startsWith('/shared/');
      const base = await realpath(path.join(root, shared ? 'app/shared' : 'app/renderer'));
      const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(shared ? 8 : 1));
      const file = await realpath(path.resolve(base, relative));
      const within = path.relative(base, file);
      if (within.startsWith('..') || path.isAbsolute(within)) return new Response(null, { status: 403 });
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8' }[path.extname(file)];
      if (!mime) return new Response(null, { status: 403 });
      return new Response(await readFile(file), { headers: {
        'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'",
      } });
    } catch { return new Response('资源不可用', { status: 404 }); }
  };
}
