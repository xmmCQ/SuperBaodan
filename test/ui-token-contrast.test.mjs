import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../app/renderer/core/ui-tokens.css', import.meta.url), 'utf8');
const token = name => {
  let hex = css.match(new RegExp(`--ui-${name}:\\s*#([0-9a-f]+);`, 'i'))?.[1];
  assert.ok(hex, name); if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
};
const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
test('必要文字在白底及96%白色玻璃最暗合成背景达到4.5:1', () => {
  for (const name of ['text', 'secondary', 'muted', 'success', 'danger', 'link']) {
    for (const background of [[255,255,255], [244.8,244.8,244.8]]) assert.ok(contrast(token(name), background) >= 4.5, name);
  }
});
test('焦点和不透明表单边界达到3:1，主操作黑白对比清楚', () => {
  assert.ok(contrast(token('control-border'), [255,255,255]) >= 3);
  assert.ok(contrast(token('focus'), [244.8,244.8,244.8]) >= 3);
  assert.ok(contrast(token('primary'), [255,255,255]) >= 4.5);
});
