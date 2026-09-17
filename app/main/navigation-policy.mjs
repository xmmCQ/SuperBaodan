import { isAppUrl } from './resources.mjs';

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return EXTERNAL_PROTOCOLS.has(url.protocol) && (url.protocol === "mailto:" || Boolean(url.hostname));
  } catch { return false; }
}

export function isLocalAppUrl(value) { return isAppUrl(value); }

export function installNavigationPolicy({ window, baseUrl, startupUrl, openExternal, onError = console.warn }) {
  const safelyOpenExternal = (url) => {
    if (!isAllowedExternalUrl(url)) return;
    Promise.resolve(openExternal(url)).catch((error) => onError(`打开外部链接失败：${error.message}`));
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalAppUrl(url, baseUrl)) Promise.resolve(window.loadURL(url)).catch((error) => onError(`页面导航失败：${error.message}`));
    else safelyOpenExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isLocalAppUrl(url, baseUrl) || url === startupUrl) return;
    event.preventDefault();
    safelyOpenExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
