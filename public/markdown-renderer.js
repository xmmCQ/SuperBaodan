const MAX_MARKDOWN_LENGTH = 200 * 1024;
let markdownEngine = null;

export { MAX_MARKDOWN_LENGTH };

export function markdownBodyWithoutFrontmatter(markdown) {
  const source = String(markdown ?? "");
  const frontmatter = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  return frontmatter ? source.slice(frontmatter[0].length) : source;
}

export function markdownToSafeHtml(markdown) {
  const source = String(markdown ?? "");
  if (source.length > MAX_MARKDOWN_LENGTH) return null;
  const engine = getMarkdownEngine();
  return engine ? engine.render(source) : null;
}

export function renderMarkdown(container, markdown, { onNotice } = {}) {
  if (!container) return "missing";
  const source = String(markdown ?? "");
  container.classList.add("markdown-body");
  if (source.length > MAX_MARKDOWN_LENGTH) {
    container.classList.add("markdown-plain");
    container.replaceChildren(document.createTextNode(source));
    container.dataset.markdownMode = "plain";
    return "plain";
  }
  const html = markdownToSafeHtml(source);
  if (html == null) {
    container.classList.add("markdown-plain");
    container.replaceChildren(document.createTextNode(source));
    container.dataset.markdownMode = "plain";
    return "plain";
  }
  container.classList.remove("markdown-plain");
  container.innerHTML = html;
  container.dataset.markdownMode = "markdown";
  secureRenderedLinks(container);
  bindCodeCopy(container, onNotice);
  return "markdown";
}

export function createMarkdownArticle(markdown, options = {}) {
  const article = document.createElement("article");
  article.className = "markdown-preview markdown-body";
  renderMarkdown(article, markdown, options);
  return article;
}

function getMarkdownEngine() {
  if (markdownEngine) return markdownEngine;
  const factory = globalThis.markdownit;
  if (typeof factory !== "function") return null;
  markdownEngine = factory({
    html: false,
    breaks: true,
    linkify: false,
    typographer: false,
  });
  markdownEngine.validateLink = isAllowedHref;
  markdownEngine.renderer.rules.fence = renderCodeFence;
  markdownEngine.renderer.rules.image = renderImageAsLink;
  return markdownEngine;
}

function renderCodeFence(tokens, index) {
  const token = tokens[index];
  const language = safeLanguageName(token.info);
  const code = escapeHtml(token.content);
  return `<div class="markdown-code-block"><div class="markdown-code-head"><span>${escapeHtml(language || "代码")}</span><button type="button" class="markdown-copy-button" data-copy-code aria-label="复制代码">复制</button></div><pre><code>${code}</code></pre></div>`;
}

function renderImageAsLink(tokens, index) {
  const token = tokens[index];
  const source = token.attrGet("src") || "";
  const label = `图片：${token.content || token.attrGet("alt") || "链接"}`;
  if (!isAllowedHref(source)) return `<span class="markdown-image-link">${escapeHtml(label)}</span>`;
  return `<a class="markdown-image-link" href="${escapeHtml(source)}">${escapeHtml(label)}</a>`;
}

function secureRenderedLinks(container) {
  for (const link of container.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (!isAllowedHref(href)) {
      link.replaceWith(document.createTextNode(link.textContent || href));
      continue;
    }
    if (/^https?:/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}

function bindCodeCopy(container, onNotice) {
  for (const button of container.querySelectorAll("[data-copy-code]")) {
    button.addEventListener("click", async () => {
      const code = button.closest(".markdown-code-block")?.querySelector("code")?.textContent || "";
      try {
        await copyText(code);
        onNotice?.("代码已复制");
      } catch {
        onNotice?.("复制失败，请手动选择代码", true);
      }
    });
  }
}

async function copyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) return globalThis.navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function isAllowedHref(value) {
  const href = String(value || "").trim();
  if (!href) return false;
  if (href.startsWith("#")) return true;
  return /^(?:https?:|mailto:)/i.test(href) && !/[\u0000-\u001f\u007f]/.test(href);
}

function safeLanguageName(value) {
  const language = String(value || "").trim().split(/\s+/, 1)[0];
  return /^[a-z0-9_+#.-]{1,30}$/i.test(language) ? language : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
