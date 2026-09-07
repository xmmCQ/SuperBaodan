import test from "node:test";
import assert from "node:assert/strict";
import { repairToolOutputEncoding } from "../public/assistant/text-normalization.js";

test("历史日期工具结果中的乱码星期可恢复显示", () => {
  assert.equal(repairToolOutputEncoding("2026-09-04 ���"), "2026-09-04 星期五");
  assert.equal(repairToolOutputEncoding("前文\n2026-09-06 �\n后文"), "前文\n2026-09-06 星期日\n后文");
  assert.equal(repairToolOutputEncoding("普通内容"), "普通内容");
  assert.equal(repairToolOutputEncoding("日期 2026-09-04 ���"), "日期 2026-09-04 ���");
});
