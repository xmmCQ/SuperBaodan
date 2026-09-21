import { fault } from '../../shared/errors.js';

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const DISABLE_KEY = "disable-model-invocation";

export function validateSkillName(value) {
  const name = String(value || "").trim();
  if (!SKILL_NAME_RE.test(name) || WINDOWS_RESERVED.test(name) || name === "." || name === "..") {
    throw fault(400, "Skill名称仅允许字母、数字、点、下划线和连字符，且不能使用Windows保留名");
  }
  return name;
}

export function parseSkillMarkdown(content) {
  const text = String(content ?? "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw fault(400, "SKILL.md必须包含YAML frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw fault(400, "SKILL.md的YAML frontmatter未闭合");
  const spans = frontmatterSpans(lines, closing);
  const name = scalarFromSpan(lines, spans.get("name"));
  const description = scalarFromSpan(lines, spans.get("description"));
  if (!name) throw fault(400, "SKILL.md缺少name");
  if (!description) throw fault(400, "SKILL.md缺少description");
  return {
    name: validateSkillName(name),
    description,
    body: lines.slice(closing + 1).join(newline).replace(/^\s*\r?\n/, ""),
    newline,
    lines,
    closing,
    spans,
  };
}

export function buildSkillMarkdown({ name, description, body = "", disableModelInvocation = false }) {
  const safeName = validateSkillName(name);
  const safeDescription = normalizeDescription(description);
  const disabled = disableModelInvocation ? `${DISABLE_KEY}: true\n` : "";
  return `---\nname: ${yamlString(safeName)}\ndescription: ${yamlString(safeDescription)}\n${disabled}---\n\n${String(body).replace(/^\s+|\s+$/g, "")}\n`;
}

export function updateStructuredSkillMarkdown(content, { description, body }) {
  const parsed = parseSkillMarkdown(content);
  const lines = [...parsed.lines];
  const descriptionSpan = parsed.spans.get("description");
  const replacement = [`description: ${yamlString(normalizeDescription(description))}`];
  if (!descriptionSpan) throw fault(400, "SKILL.md缺少description");
  lines.splice(descriptionSpan.start, descriptionSpan.end - descriptionSpan.start, ...replacement);
  const closing = lines.indexOf("---", 1);
  const head = lines.slice(0, closing + 1).join(parsed.newline);
  return `${head}${parsed.newline}${parsed.newline}${String(body ?? "").replace(/^\s+|\s+$/g, "")}${parsed.newline}`;
}

export function setDisableModelInvocation(content, disable) {
  const parsed = parseSkillMarkdown(content);
  const lines = [...parsed.lines];
  const span = parsed.spans.get(DISABLE_KEY);
  if (disable) {
    if (span) lines.splice(span.start, span.end - span.start, `${DISABLE_KEY}: true`);
    else lines.splice(1, 0, `${DISABLE_KEY}: true`);
  } else if (span) {
    lines.splice(span.start, span.end - span.start);
  } else return content;
  return lines.join(parsed.newline);
}

function normalizeDescription(value) {
  const description = String(value || "").trim();
  if (!description) throw fault(400, "Skill描述不能为空");
  if (description.length > 2000) throw fault(400, "Skill描述不能超过2000字");
  return description;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function frontmatterSpans(lines, closing) {
  const spans = new Map();
  let active = null;
  for (let i = 1; i < closing; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match) continue;
    if (active) active.end = i;
    if (spans.has(match[1])) throw fault(400, `frontmatter包含重复字段：${match[1]}`);
    active = { start: i, end: closing };
    spans.set(match[1], active);
  }
  return spans;
}

export function scalarFromSpan(lines, span) {
  if (!span) return "";
  const first = lines[span.start].replace(/^[^:]+:\s*/, "").trim();
  if (first === "|" || first === ">" || first.startsWith("|-") || first.startsWith(">-")) {
    return lines.slice(span.start + 1, span.end).map((line) => line.replace(/^\s{1,4}/, "")).join(" ").trim();
  }
  if ((first.startsWith('"') && first.endsWith('"')) || (first.startsWith("'") && first.endsWith("'"))) {
    if (first.startsWith('"')) { try { return JSON.parse(first); } catch {} }
    return first.slice(1, -1).replace(/''/g, "'");
  }
  return first.replace(/\s+#.*$/, "").trim();
}
