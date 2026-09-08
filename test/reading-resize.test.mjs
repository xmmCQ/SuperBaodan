import test from "node:test";
import assert from "node:assert/strict";
import { beginReadingResize } from "../public/core/reading-position.js";

test("连续缩放只捕获一次锚点，逐帧不追加回调，结束后清理", (t) => {
  const previous = globalThis.requestAnimationFrame, frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  let scans = 0, offset = 20;
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: offset, bottom: offset + 40, height: 40 }) };
  const node = { clientHeight: 200, scrollHeight: 2000, scrollTop: 300, scrollLeft: 0,
    style: { scrollBehavior: "smooth", overflowAnchor: "auto" }, dataset: {},
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelectorAll: () => { scans++; return [anchor]; }, contains: (item) => item === anchor,
  };
  const resize = beginReadingResize([node, node]);
  for (let i = 0; i < 60; i++) { offset = 21; resize.restore(); }
  assert.equal(scans, 1); assert.equal(frames.length, 0);
  assert.equal(node.scrollTop, 360); assert.equal(node.dataset.readingAdjustment, "true");
  resize.finish(); resize.finish();
  assert.equal(frames.length, 1);
  while (frames.length) frames.shift()();
  assert.equal(scans, 1); assert.equal(node.dataset.readingAdjustment, undefined);
  assert.equal(node.style.scrollBehavior, "smooth"); assert.equal(node.style.overflowAnchor, "auto");
});

test("新的拖动取代旧拖动时，旧清理不会解除新拖动保护", (t) => {
  const previous = globalThis.requestAnimationFrame, frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  const node = { clientHeight: 100, scrollHeight: 100, scrollTop: 0, scrollLeft: 0,
    style: { scrollBehavior: "smooth", overflowAnchor: "auto" }, dataset: {}, children: [],
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }), querySelectorAll: () => [],
  };
  const first = beginReadingResize([node]); first.finish();
  const second = beginReadingResize([node]);
  while (frames.length) frames.shift()();
  assert.equal(node.dataset.readingAdjustment, "true");
  second.finish(); while (frames.length) frames.shift()();
  assert.equal(node.style.scrollBehavior, "smooth"); assert.equal(node.dataset.readingAdjustment, undefined);
});
