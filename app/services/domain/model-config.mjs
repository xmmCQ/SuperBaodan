import { fault } from '../../shared/errors.js';

export const KEEP_SECRET = "__SUPER_BAODAN_KEEP_SECRET__";

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

export const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseJsonc(text) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; output += char; }
      else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; output += "  "; i++; }
      else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quote = char; output += char; continue; }
    if (char === "/" && next === "/") { lineComment = true; output += "  "; i++; continue; }
    if (char === "/" && next === "*") { blockComment = true; output += "  "; i++; continue; }
    output += char;
  }
  // models.json is JSON with comments/trailing commas. Single-quoted strings are not supported.
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; cleaned += char; continue; }
    if (char === ",") {
      let lookahead = i + 1;
      while (/\s/.test(output[lookahead] || "")) lookahead++;
      if (output[lookahead] === "}" || output[lookahead] === "]") continue;
    }
    cleaned += char;
  }
  return JSON.parse(cleaned);
}

export function redactSecrets(value, key = "", parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, "", key));
  if (!value || typeof value !== "object") {
    if (key === "apiKey" || (parentKey === "headers" && SENSITIVE_HEADER.test(key))) return value == null || value === "" ? value : KEEP_SECRET;
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey, key)]));
}

export function mergeSecretPlaceholders(incoming, current, key = "", parentKey = "") {
  if (incoming === KEEP_SECRET && (key === "apiKey" || (parentKey === "headers" && SENSITIVE_HEADER.test(key)))) return current;
  if (Array.isArray(incoming)) return incoming.map((item, index) => mergeSecretPlaceholders(item, Array.isArray(current) ? current[index] : undefined, "", key));
  if (!incoming || typeof incoming !== "object") return incoming;
  const result = {};
  for (const [childKey, child] of Object.entries(incoming)) result[childKey] = mergeSecretPlaceholders(child, current?.[childKey], childKey, key);
  return result;
}

export function validateAndNormalizeModelsConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fault(400, "模型配置必须是对象");
  if (!data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) throw fault(400, "模型配置缺少 providers对象");
  const normalized = structuredClone(data);
  for (const [providerId, provider] of Object.entries(normalized.providers)) {
    if (!validProviderId(providerId)) throw fault(400, `供应商ID无效：${providerId}`);
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw fault(400, `供应商配置无效：${providerId}`);
    if (provider.baseUrl != null && provider.baseUrl !== "") {
      try { new URL(provider.baseUrl); } catch { throw fault(400, `Base URL无效：${providerId}`); }
    }
    if (provider.models != null && !Array.isArray(provider.models)) throw fault(400, `${providerId}.models必须是数组`);
    const seen = new Set();
    provider.models = (provider.models || []).filter((model) => model && typeof model === "object").map((model) => {
      const id = String(model.id || "").trim();
      if (!id) throw fault(400, `${providerId}存在空模型ID`);
      if (seen.has(id)) throw fault(400, `${providerId}存在重复模型ID：${id}`);
      seen.add(id);
      model.id = id;
      for (const field of ["contextWindow", "maxTokens"]) {
        if (model[field] != null && (!Number.isFinite(Number(model[field])) || Number(model[field]) < 0)) throw fault(400, `${providerId}/${id} 的 ${field}无效`);
        if (model[field] != null) model[field] = Number(model[field]);
      }
      if (model.cost && typeof model.cost === "object") {
        const values = {};
        for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
          const number = model.cost[field] == null || model.cost[field] === "" ? 0 : Number(model.cost[field]);
          if (!Number.isFinite(number) || number < 0) throw fault(400, `${providerId}/${id} 的成本无效`);
          values[field] = number;
        }
        model.cost = { ...model.cost, ...values };
      }
      return model;
    });
  }
  return normalized;
}

export function validProviderId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}
