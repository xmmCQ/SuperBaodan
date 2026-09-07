import { EventEmitter } from "node:events";

export class ControlledPiChild extends EventEmitter {
  constructor(sessionFile, options = {}) {
    super();
    this.sessionFile = sessionFile;
    this.sessionId = options.sessionId || "test-session";
    this.ignoreTerm = Boolean(options.ignoreTerm);
    this.failGetState = Boolean(options.failGetState || options.failHandshake);
    this.responseDelayMs = options.responseDelayMs || 0;
    this.pid = options.pid || Math.floor(10_000 + Math.random() * 10_000);
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
    this.stdin = {
      writable: true,
      end: () => { this.stdin.writable = false; },
      write: (line, callback) => {
        const command = JSON.parse(line);
        setTimeout(() => this.respond(command), this.responseDelayMs);
        callback?.();
      },
    };
  }

  respond(command) {
    const failed = command.type === "get_state" && this.failGetState;
    const data = command.type === "get_state"
      ? { sessionFile: this.sessionFile, sessionId: this.sessionId, isStreaming: false }
      : null;
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "response",
      id: command.id,
      command: command.type,
      success: !failed,
      error: failed ? "handshake failed" : undefined,
      data,
    })}\n`));
  }

  pushEvent(event) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  }

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    if (this.exitCode !== null) return true;
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    setImmediate(() => this.emit("exit", this.exitCode, signal));
    return true;
  }
}
