// 所有桌面退出入口共用这一条静默清理路径。
export class ExitCoordinator {
  constructor({ begin = () => {}, stopBackend, forceStop, setStatus = () => {}, finish, forceFailed = () => {} }) {
    Object.assign(this, { begin, stopBackend, forceStop, setStatus, finish, forceFailed });
    this.promise = null;
    this.finishing = false;
  }

  request() {
    if (this.promise) return this.promise;
    this.promise = Promise.resolve().then(() => this.run());
    this.promise.finally(() => { if (!this.finishing) this.promise = null; }).catch(() => {});
    return this.promise;
  }

  async run() {
    this.begin();
    this.setStatus({ state: "stopping", message: "正在安全退出，请稍候……" });
    let stopped = false;
    try { stopped = await this.stopBackend(); } catch {}
    if (!stopped) {
      try { stopped = await this.forceStop(); } catch {}
    }
    if (!stopped) {
      await this.forceFailed();
      return { ok: false, forceFailed: true };
    }
    this.finishing = true;
    await this.finish();
    return { ok: true };
  }
}
