import test from "node:test";
import assert from "node:assert/strict";
import { proportionalScrollTop } from "../public/ui-dialog.js";

test("Markdown编辑器按滚动比例同步且限制在有效范围", () => {
  const source = { scrollHeight: 1000, clientHeight: 200, scrollTop: 400 };
  const target = { scrollHeight: 2000, clientHeight: 500 };
  assert.equal(proportionalScrollTop(source, target), 750);
  assert.equal(proportionalScrollTop({ ...source, scrollTop: -20 }, target), 0);
  assert.equal(proportionalScrollTop({ ...source, scrollTop: 2000 }, target), 1500);
  assert.equal(proportionalScrollTop({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 }, target), 0);
  assert.equal(proportionalScrollTop(source, { scrollHeight: 500, clientHeight: 500 }), 0);
});
