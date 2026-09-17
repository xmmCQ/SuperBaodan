export class ExitCoordinator {
  constructor({ begin = () => {}, getPageState, confirmExit, stopBackend, decideTimeout, forceStop, setStatus = () => {}, finish, forceFailed = () => {} }) {
    Object.assign(this, { begin, getPageState, confirmExit, stopBackend, decideTimeout, forceStop, setStatus, finish, forceFailed });
    this.promise = null;
    this.finishing = false;
  }

  request(details = {}) {
    if (this.promise) return this.promise;
    const operation = this.run(details);
    this.promise = operation;
    operation.finally(() => { if (!this.finishing && this.promise === operation) this.promise = null; }).catch(() => {});
    return operation;
  }

  async run(details) {
    this.begin(details);
    if (!details.silent) {
      const state = await this.getPageState();
      if (!await this.confirmExit(state, details)) return { ok: false, cancelled: true };
    }
    this.setStatus({ state: "stopping", message: "正在安全退出，请稍候……" });
    let stopped = await this.stopBackend(details);
    if (details.silent && !stopped) {
      stopped = await this.forceStop(details);
      if (!stopped) {
        await this.forceFailed(details);
        return { ok: false, forceFailed: true };
      }
    }
    while (!details.silent && !stopped) {
      const decision = await this.decideTimeout(details);
      stopped = decision === "force" ? await this.forceStop(details) : await this.stopBackend(details);
      if (decision === "force" && !stopped) {
        await this.forceFailed(details);
        return { ok: false, forceFailed: true };
      }
    }
    this.finishing = true;
    await this.finish(details);
    return { ok: true };
  }
}
