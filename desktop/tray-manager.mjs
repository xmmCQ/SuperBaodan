export class TrayManager {
  constructor({ iconFile, createTray, buildMenu, showWindow, requestExit, onError = () => {} }) {
    Object.assign(this, { iconFile, createTray, buildMenu, showWindow, requestExit, onError });
    this.tray = null;
  }

  create() {
    if (this.tray) return true;
    try {
      const tray = this.createTray(this.iconFile);
      tray.setToolTip("超级宝蛋");
      tray.setContextMenu(this.buildMenu([
        { label: "显示窗口", click: () => this.show() },
        { type: "separator" },
        { label: "退出", click: () => this.exit() },
      ]));
      tray.on("click", () => this.show());
      this.tray = tray;
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  show() {
    try { return this.showWindow(); }
    catch (error) { this.onError(error); return false; }
  }

  exit() {
    try { Promise.resolve(this.requestExit()).catch((error) => this.onError(error)); }
    catch (error) { this.onError(error); }
  }

  destroy() {
    if (!this.tray) return;
    try { this.tray.destroy(); }
    catch (error) { this.onError(error); }
    this.tray = null;
  }
}
