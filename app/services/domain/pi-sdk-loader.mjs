import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fault } from '../../shared/errors.js';

export function piPackageRoot(env = process.env) {
  return env.SUPER_BAODAN_PI_PACKAGE || path.join(env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
}

export async function loadThinkingCapabilities(env = process.env) {
  // pi-ai exports compat only for ESM, so require.resolve(subpath) cannot be used.
  const resolve = createRequire(path.join(piPackageRoot(env), 'package.json')).resolve;
  const packageFile = (resolve.paths('@earendil-works/pi-ai') || []).map(dir => path.join(dir,'@earendil-works/pi-ai/package.json')).find(existsSync);
  if (!packageFile) throw fault(503, '当前 Pi SDK 缺少模型能力模块');
  const target = JSON.parse(readFileSync(packageFile,'utf8')).exports?.['./compat']?.import;
  if (typeof target !== 'string' || !target.startsWith('./')) throw fault(503, '当前 Pi SDK 不提供模型能力接口');
  const root = path.dirname(packageFile), entry = path.resolve(root,target);
  if (!entry.startsWith(root + path.sep)) throw fault(503, '模型能力模块路径无效');
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.getSupportedThinkingLevels !== 'function') throw fault(503, '当前 Pi SDK 无法读取模型思考能力');
  return module.getSupportedThinkingLevels;
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
