import { BrowserWindow, screen } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeWindowState, validBounds } from "./window-state.mjs";

export class WindowManager {
  constructor({ stateFile, preloadFile, startupFile, iconFile, onCloseRequested, onSessionEnd }) {
    this.stateFile = stateFile;
    this.preloadFile = preloadFile;
    this.startupFile = startupFile;
    this.startupUrl = pathToFileURL(startupFile).href;
    this.iconFile = iconFile;
    this.onCloseRequested = onCloseRequested;
    this.onSessionEnd = onSessionEnd;
    this.window = null;
    this.allowClose = false;
    this.closeToTray = false;
    this.closeRequested = false;
    this.saveTimer = null;
    this.businessLoaded = false;
  }

  async create() {
    const saved = await this.readState();
    const layout = normalizeWindowState(saved, screen.getAllDisplays(), screen.getPrimaryDisplay());
    const window = new BrowserWindow({
      title: "超级宝蛋",
      icon: this.iconFile,
      show: false,
      minWidth: layout.minimumWidth,
      minHeight: layout.minimumHeight,
      ...layout.bounds,
      webPreferences: {
        preload: this.preloadFile,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.window = window;
    window.setMenuBarVisibility(false);
    if (layout.maximized) window.maximize();
    window.once("ready-to-show", () => window.show());
    for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, () => this.scheduleSave());
    window.on("close", (event) => {
      if (this.allowClose) return;
      event.preventDefault();
      if (this.closeToTray) {
        window.hide();
        return;
      }
      if (this.closeRequested) return;
      this.closeRequested = true;
      Promise.resolve(this.onCloseRequested?.({ source: "window" })).finally(() => { this.closeRequested = false; }).catch(() => {});
    });
    window.on("session-end", () => this.onSessionEnd?.());
    window.on("closed", () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.window = null;
    });
    await window.loadFile(this.startupFile);
    return window;
  }

  async loadApplication(url) {
    await this.window?.loadURL(url);
    this.businessLoaded = true;
  }

  async showStartup(status) {
    if (!this.window || this.businessLoaded) return false;
    if (this.window.webContents.getURL() !== this.startupUrl) await this.window.loadFile(this.startupFile);
    this.window.webContents.send("desktop:startup-status", status);
    return true;
  }

  sendBackendStatus(status) {
    if (!this.window || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send("desktop:backend-status", status);
  }

  focus() {
    if (!this.window || this.window.isDestroyed()) return false;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    return true;
  }

  enableCloseToTray() { this.closeToTray = true; }
  disableCloseToTray() { this.closeToTray = false; }

  async pageCloseState(timeoutMs = 1_500) {
    if (!this.window || this.window.webContents.isDestroyed() || !this.businessLoaded) return { unsaved: false, busy: false, reasons: [] };
    try {
      const query = this.window.webContents.executeJavaScript(
        "Promise.resolve(window.superBaodanDesktopRuntime?.getCloseState?.())",
        true,
      );
      const result = await withTimeout(query, timeoutMs);
      if (!result || typeof result !== "object" || !Array.isArray(result.reasons)) throw new Error("页面返回了无效状态");
      return {
        unsaved: Boolean(result.unsaved),
        busy: Boolean(result.busy),
        reasons: result.reasons.filter((item) => typeof item === "string").slice(0, 12),
      };
    } catch (error) {
      return { unsaved: true, busy: false, reasons: ["无法确认页面是否存在未保存内容"], unknown: true, error: error.message };
    }
  }

  permitClose() { this.allowClose = true; }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveState(), 250);
  }

  async saveState() {
    if (!this.window || this.window.isDestroyed()) return false;
    const bounds = this.window.getNormalBounds();
    if (!validBounds(bounds)) return false;
    const state = { bounds, maximized: this.window.isMaximized() };
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await rename(temporary, this.stateFile);
      return true;
    } catch { return false; }
  }

  async readState() {
    try { return JSON.parse(await readFile(this.stateFile, "utf8")); }
    catch { return null; }
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("读取页面状态超时")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
