import { createSmokeServer } from './smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './browser-harness.mjs';
import { createTestScreenshots } from './test-screenshots.mjs';

// One independent server/profile per test. Reuse within a scenario only.
export async function browserScenario(t, { width = 1440, height = 900, configure, initScript } = {}) {
  if (!edgeAvailable()) { t.skip('需要 Edge'); return null; }
  let browser;
  const screenshots = createTestScreenshots(t, () => browser);
  const fixture = await createSmokeServer();
  t.after(async () => {
    try { await screenshots.finish(t.error); }
    finally { try { await browser?.close(); } finally { await fixture.close(); } }
  });
  await configure?.(fixture);
  browser = await launchBrowser();
  await browser.setViewport(width, height);
  if (initScript) await browser.addInitScript(initScript);
  const base = `http://127.0.0.1:${fixture.port}`;
  const navigate = async (page = '/assistant.html') => {
    await browser.navigate(base + page);
    await browser.waitFor(page === '/' ? "!document.documentElement.classList.contains('app-loading')" : "document.querySelector('#messages .bubble')");
  };
  return { fixture, browser, base, navigate, shot: screenshots.shot };
}
export const paint = browser => browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');

export async function settingsTab(browser, tab) {
  await browser.evaluate(`if (!settingsDialog.open) settingsButton.click();document.querySelector('[data-settings-tab=${tab}]').click()`);
  await browser.waitFor(`document.getElementById('${tab}Tab').classList.contains('active')`);
  if (tab === 'projectPrompt') await browser.waitFor("!document.querySelector('.project-prompt-reload').disabled");
  if (tab === 'preferences') await browser.waitFor('defaultModelSelect.options.length>0');
  if (tab === 'accounts') await browser.waitFor("document.querySelector('.provider-card')");
  await paint(browser);
}
