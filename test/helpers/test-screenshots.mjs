import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Never create files for successful tests unless visual review is explicitly enabled.
export function createTestScreenshots(t, getBrowser, {
  mode = process.env.SUPER_BAODAN_TEST_SCREENSHOTS || 'failure', timeout = 2000,
} = {}) {
  if (!['failure', 'visual', 'off'].includes(mode)) throw new Error('截图模式必须为 failure、visual 或 off');
  let directory, sequence = 0, failureCaptured = false;
  async function capture(label) {
    const browser = getBrowser(); if (!browser) return null;
    let timer;
    try {
      const png = await Promise.race([
        browser.screenshot(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('截图超时')), timeout); }),
      ]);
      directory ||= await mkdtemp(path.join(os.tmpdir(), 'sb-test-diagnostics-'));
      const safe = String(label).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80);
      const file = path.join(directory, `${++sequence}-${safe || 'scene'}.png`);
      await writeFile(file, png);
      t.diagnostic(`测试图片：${file}`);
      return file;
    } catch (error) {
      // Diagnostics must not replace the original assertion/setup failure.
      t.diagnostic(`未保存测试图片：${error.message}`);
      return null;
    } finally { clearTimeout(timer); }
  }
  return {
    shot: label => mode === 'visual' ? capture(label) : Promise.resolve(null),
    async finish(error) {
      if (!error || mode === 'off' || failureCaptured) return null;
      failureCaptured = true;
      return capture(`${t.name}-failure`);
    },
  };
}
