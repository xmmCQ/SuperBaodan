export function sessionState(session) {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  };
}

export async function dispatchSdkCommand(runtime, session, command) {
  switch (command.type) {
    case "prompt": return runtime.submitPrompt(session, command);
    case "steer": await session.steer(command.message, command.images); return null;
    case "follow_up": await session.followUp(command.message, command.images); return null;
    case "abort":
      runtime.uiBridge?.cancelAll();
      session.clearQueue();
      session.abortCompaction();
      session.abortBash();
      await session.abort();
      return null;
    case "clear_queue": return session.clearQueue();
    case "get_state": return { ...sessionState(session), isStreaming: Boolean(session.isStreaming || runtime.promptRuns.size) };
    case "get_messages": return { messages: session.messages };
    case "get_available_models": return { models: session.modelRuntime.getAvailableSnapshot() };
    case "get_available_thinking_levels": return { levels: session.getAvailableThinkingLevels() };
    case "set_model": {
      const model = session.modelRuntime.getAvailableSnapshot().find((item) => item.provider === command.provider && item.id === command.modelId);
      if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
      await session.setModel(model);
      return model;
    }
    case "set_thinking_level": session.setThinkingLevel(command.level); return null;
    case "compact": return session.compact(command.customInstructions);
    case "set_auto_compaction": session.setAutoCompactionEnabled(command.enabled); return null;
    case "set_auto_retry": session.setAutoRetryEnabled(command.enabled); return null;
    case "abort_retry": session.abortRetry(); return null;
    case "bash": {
      const intercepted = await session.extensionRunner.emitUserBash({
        type: "user_bash", command: command.command,
        excludeFromContext: command.excludeFromContext ?? false, cwd: session.sessionManager.getCwd(),
      });
      if (intercepted?.result) {
        session.recordBashResult(command.command, intercepted.result, { excludeFromContext: command.excludeFromContext });
        return intercepted.result;
      }
      return session.executeBash(command.command, undefined, { excludeFromContext: command.excludeFromContext, id: command.id, operations: intercepted?.operations });
    }
    case "abort_bash": session.abortBash(); return null;
    case "get_session_stats": return session.getSessionStats();
    case "get_last_assistant_text": return { text: session.getLastAssistantText() };
    case "set_session_name": {
      const name = String(command.name || "").trim();
      if (!name || name.length > 120) throw new Error("会话名称应为 1 至 120 个字符");
      session.setSessionName(name);
      return null;
    }
    case "get_commands": return {
      commands: [
        ...session.extensionRunner.getRegisteredCommands().map((item) => ({ name: item.invocationName, description: item.description, source: "extension", sourceInfo: item.sourceInfo })),
        ...session.promptTemplates.map((item) => ({ name: item.name, description: item.description, source: "prompt", sourceInfo: item.sourceInfo })),
        ...session.resourceLoader.getSkills().skills.map((item) => ({ name: `skill:${item.name}`, description: item.description, source: "skill", sourceInfo: item.sourceInfo })),
      ],
    };
    default: throw new Error(`不支持的命令：${command.type}`);
  }
}
