import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const vendorUrl = new URL("../public/vendor/markdown-it-14.1.0.min.js", import.meta.url);
const vendorSource = await readFile(vendorUrl, "utf8");
const vendorLicense = await readFile(new URL("../public/vendor/markdown-it-LICENSE.txt", import.meta.url), "utf8");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(vendorSource, sandbox);
globalThis.markdownit = sandbox.markdownit;
const { markdownToSafeHtml, markdownBodyWithoutFrontmatter, MAX_MARKDOWN_LENGTH } = await import(`../public/markdown-renderer.js?test=${Date.now()}`);

test("内置固定版本markdown-it并保留许可证", () => {
  assert.equal(createHash("sha256").update(vendorSource).digest("hex"), "38c70a1e7ca91ab40e2d9e6e60129851a717ed1c7d4acbbdd41bf9503791cf68");
  assert.match(vendorLicense, /Permission is hereby granted, free of charge/);
});

test("Markdown渲染器支持常用对话格式", () => {
  const html = markdownToSafeHtml(`# 标题\n\n**粗体**和*斜体*\n\n- 项目一\n- 项目二\n\n|列A|列B|\n|-|-|\n|1|2|\n\n> 引用\n\n\`行内\`\n\n\`\`\`js\nconst n = 1;\n\`\`\``);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<code>行内<\/code>/);
  assert.match(html, /markdown-copy-button/);
  assert.match(html, />js<\/span>/);
});

test("Markdown渲染器禁止HTML、危险链接和远程图片请求", () => {
  const html = markdownToSafeHtml(`<script>globalThis.pwned = true</script>\n\n[x](javascript:alert(1))\n\n![示例](https://example.com/a.png)`);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /class="markdown-image-link"/);
});

test("超长Markdown降级为纯文本", () => {
  assert.equal(markdownToSafeHtml("a".repeat(MAX_MARKDOWN_LENGTH + 1)), null);
});

test("完整SKILL.md预览仅移除闭合的frontmatter", () => {
  assert.equal(markdownBodyWithoutFrontmatter('---\nname: "demo"\n---\n# 正文'), "# 正文");
  assert.equal(markdownBodyWithoutFrontmatter('---\r\nname: "demo"\r\n...\r\n正文'), "正文");
  const malformed = '---\nname: "demo"\n# 正文';
  assert.equal(markdownBodyWithoutFrontmatter(malformed), malformed);
  assert.equal(markdownBodyWithoutFrontmatter("# 正文\n\n---\n分隔线"), "# 正文\n\n---\n分隔线");
});

