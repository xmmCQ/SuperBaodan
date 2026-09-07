import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_COMMAND_TYPES, assertAllowedAgentCommand } from "../lib/agent-commands.mjs";

test("agent command whitelist保留普通会话命令", () => {
  for (const type of ["get_messages", "set_session_name", "get_session_stats"]) {
    assert.equal(AGENT_COMMAND_TYPES.has(type), true, `${type} should be allowed`);
  }
});

test("agent command whitelist拒绝分支及未知命令", () => {
  for (const type of ["fork", "get_fork_messages", "get_entries", "get_tree"]) {
    assert.equal(AGENT_COMMAND_TYPES.has(type), false, `${type} should not be allowed`);
    assert.throws(() => assertAllowedAgentCommand({ type, entryId: "abc12345" }), /不支持的命令/);
  }
  assert.throws(() => assertAllowedAgentCommand({ type: "rewrite_session_jsonl" }), /不支持的命令/);
});
