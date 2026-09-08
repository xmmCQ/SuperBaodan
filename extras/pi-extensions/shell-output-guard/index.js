export const SHELL_OUTPUT_RULE = "终端规则：bash 工具按 Bash 语法执行，即使系统是 Windows，丢弃输出也必须使用 /dev/null（如 2>/dev/null），禁止使用 CMD 的 >nul、2>nul。powershell 工具丢弃输出使用 $null（如 2>$null）或 Out-Null。只有明确交给 cmd.exe /c 执行的命令字符串内部才使用 NUL。不要在工作区创建名为 nul 的输出文件。";

// Detect literal redirection targets, not text inside quoted arguments/comments.
// This is an accidental-file guard, not a shell sandbox or a full shell parser.
export function hasNulRedirection(command, shell = "bash") {
  if (typeof command !== "string") return false;
  const escape = shell === "powershell" ? "`" : "\\";
  function quoted(start) {
    const quote = command[start];
    let value = "", i = start + 1;
    for (; i < command.length; i += 1) {
      if (command[i] === quote) return { value, end: i + 1 };
      if (quote === '"' && command[i] === escape && i + 1 < command.length) i += 1;
      value += command[i];
    }
    return { value, end: i };
  }
  for (let i = 0; i < command.length;) {
    const character = command[i];
    if (character === escape) { i += 2; continue; }
    if (character === "'" || character === '"') { i = quoted(i).end; continue; }
    if (character === "#" && (i === 0 || /[\s;|&()]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (character !== ">") { i += 1; continue; }
    while (command[i] === ">" || command[i] === "|") i += 1;
    while (/[ \t]/.test(command[i] || "")) i += 1;
    let target = "";
    while (i < command.length && !/[\s;|&()<>]/.test(command[i])) {
      if (command[i] === "'" || command[i] === '"') {
        const part = quoted(i); target += part.value; i = part.end;
      } else if (command[i] === escape && i + 1 < command.length) {
        target += command[i + 1]; i += 2;
      } else target += command[i++];
    }
    if (/(?:^|[\\/])nul$/i.test(target)) return true;
  }
  return false;
}

export function shellOutputError(command, shell = "bash") {
  if (!hasNulRedirection(command, shell)) return null;
  const replacement = shell === "powershell" ? "2>$null 或 Out-Null" : "2>/dev/null";
  return `已阻止命令：当前 ${shell} 工具中的 >nul 会误写输出文件，请改用 ${replacement} 后重试。`;
}

export default function shellOutputGuard(pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${SHELL_OUTPUT_RULE}` }));
  pi.on("tool_call", (event) => {
    if (!["bash", "powershell"].includes(event.toolName)) return;
    const reason = shellOutputError(event.input?.command, event.toolName);
    if (reason) return { block: true, reason };
  });
  pi.on("user_bash", (event) => {
    const reason = shellOutputError(event.command);
    if (reason) return { result: { output: reason, exitCode: 1, cancelled: true, truncated: false } };
  });
}
