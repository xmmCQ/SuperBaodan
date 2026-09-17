export const AGENT_COMMAND_TYPES = new Set([
  "prompt", "abort", "clear_queue", "steer", "follow_up", "set_model", "set_thinking_level", "compact",
  "set_auto_compaction", "set_auto_retry", "get_state", "get_messages", "get_available_models",
  "get_available_thinking_levels", "get_commands", "set_session_name", "bash", "abort_bash", "get_session_stats",
  "get_last_assistant_text", "extension_ui_response", "abort_retry",
]);

export function assertAllowedAgentCommand(command) {
  if (!command || typeof command !== "object" || !AGENT_COMMAND_TYPES.has(command.type)) {
    const error = new Error(`不支持的命令：${command?.type || "unknown"}`);
    error.statusCode = 400;
    throw error;
  }
  return command;
}
