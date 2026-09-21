import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fault } from '../../shared/errors.js';

export function piPackageRoot(env = process.env) {
  return env.SUPER_BAODAN_PI_PACKAGE || path.join(env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
}

export async function loadPiSdk(env = process.env) {
  const root = piPackageRoot(env);
  const entry = path.join(root, "dist", "index.js");
  if (!existsSync(entry)) throw fault(503, "未找到 Windows Pi SDK，请先安装 Windows Pi");
  const sdk = await import(pathToFileURL(entry).href);
  if (typeof sdk.ModelRuntime?.create !== "function" || typeof sdk.SettingsManager?.create !== "function") {
    throw fault(503, "Windows Pi SDK版本不兼容，请更新 Pi");
  }
  return sdk;
}
