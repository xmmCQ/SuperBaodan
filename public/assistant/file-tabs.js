export function fileTabKey(filePath) {
  const parts = [];
  for (const part of String(filePath).replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/").toLowerCase();
}

export function createFileTabs({ elements: el, loadFile, contentUrl, createMarkdownArticle, onNotice, onError, onActivePath }) {
  const tabs = new Map();
  let activeKey = null, workspaceKey = null, generation = 0, nextId = 0;
  el.fileTabs.setAttribute("role", "tablist");
  el.fileTabs.setAttribute("aria-label", "已打开的文件");
  function remember(tab) {
    if (tab) tab.scroll = { top: tab.pane.scrollTop, left: tab.pane.scrollLeft };
  }
  function renderTabs() {
    el.fileTabs.replaceChildren();
    const items = [...tabs.values()];
    for (const [index, tab] of items.entries()) {
      const row = document.createElement("div"); row.className = `file-tab${tab.key === activeKey ? " active" : ""}`;
      const select = document.createElement("button"); select.type = "button"; select.className = "file-tab-select";
      select.id = tab.id; select.setAttribute("role", "tab"); select.setAttribute("aria-selected", String(tab.key === activeKey));
      select.setAttribute("aria-controls", `${tab.id}-pane`); select.tabIndex = tab.key === activeKey ? 0 : -1;
      select.title = tab.path;
      const segments = tab.path.replaceAll("\\", "/").split("/"), name = segments.pop();
      const duplicate = items.filter((item) => item.path.replaceAll("\\", "/").split("/").at(-1).toLowerCase() === name.toLowerCase()).length > 1;
      select.textContent = duplicate ? `${name} — ${segments.join("/") || "根目录"}` : name;
      select.addEventListener("click", () => activate(tab.key));
      select.addEventListener("keydown", (event) => {
        let target;
        if (event.key === "ArrowRight") target = items[(index + 1) % items.length];
        if (event.key === "ArrowLeft") target = items[(index + items.length - 1) % items.length];
        if (event.key === "Home") target = items[0];
        if (event.key === "End") target = items.at(-1);
        if (target) { event.preventDefault(); activate(target.key); document.getElementById(target.id)?.focus(); }
      });
      const close = document.createElement("button"); close.type = "button"; close.className = "file-tab-close"; close.textContent = "×";
      close.title = `关闭 ${tab.path}`; close.setAttribute("aria-label", close.title);
      close.addEventListener("click", () => closeTab(tab.key));
      row.append(select, close); el.fileTabs.append(row);
    }
    document.getElementById(tabs.get(activeKey)?.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function activate(key) {
    const tab = tabs.get(key);
    if (!tab) return;
    if (activeKey !== key) remember(tabs.get(activeKey));
    activeKey = key;
    for (const item of tabs.values()) item.pane.classList.toggle("hidden", item !== tab);
    el.previewTitle.textContent = tab.path; el.previewTitle.title = tab.path;
    el.insertPreviewPath.classList.remove("hidden");
    onActivePath(tab.path);
    renderTabs();
    const restore = () => {
      if (activeKey !== key || !tabs.has(key)) return;
      tab.pane.scrollTop = tab.scroll.top; tab.pane.scrollLeft = tab.scroll.left;
    };
    restore(); requestAnimationFrame(restore);
  }
  function empty() {
    activeKey = null;
    el.previewTitle.textContent = "预览"; el.previewTitle.title = "";
    el.insertPreviewPath.classList.add("hidden");
    el.filePreview.className = "file-preview muted";
    el.filePreview.textContent = "点击文件进行预览";
    el.fileTabs.replaceChildren(); onActivePath(null);
  }
  function closeTab(key) {
    const tab = tabs.get(key); if (!tab) return;
    const order = [...tabs.keys()], index = order.indexOf(key), active = activeKey === key;
    tab.controller?.abort(); tab.pane.remove(); tabs.delete(key);
    if (!tabs.size) { empty(); return; }
    if (active) { activeKey = null; activate([...tabs.keys()][Math.min(index, tabs.size - 1)]); }
    else renderTabs();
  }
  function renderFile(tab, data) {
    const pane = tab.pane;
    pane.replaceChildren();
    if (["text", "code"].includes(data.kind)) {
      const pre = document.createElement("pre"); pre.textContent = data.content; pane.append(pre);
    } else if (data.kind === "markdown") pane.append(createMarkdownArticle(data.content, { onNotice }));
    else if (data.kind === "image") {
      const image = document.createElement("img"); image.src = contentUrl(data.contentUrl); image.alt = data.path; pane.append(image);
    } else if (data.kind === "pdf") {
      const frame = document.createElement("iframe"); frame.src = contentUrl(data.contentUrl); frame.title = data.path; pane.append(frame);
    } else pane.textContent = "此文件不能在页面中预览，可插入 @路径让宝蛋读取处理。";
  }
  function open(filePath, { previewable = true, reload = false } = {}) {
    const key = fileTabKey(filePath);
    let tab = tabs.get(key);
    if (tab && !reload) { if (activeKey !== key) activate(key); return tab.promise || Promise.resolve(); }
    if (!tab) {
      if (!tabs.size) { el.filePreview.replaceChildren(); el.filePreview.className = "file-preview"; }
      const pane = document.createElement("div"); pane.className = "file-preview-pane hidden";
      tab = { key, path: filePath, pane, id: `file-tab-${++nextId}`, scroll: { top: 0, left: 0 }, load: 0 };
      pane.id = `${tab.id}-pane`; pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-labelledby", tab.id);
      pane.tabIndex = 0; tabs.set(key, tab); el.filePreview.append(pane);
    } else if (activeKey === key) remember(tab);
    tab.controller?.abort(); tab.controller = new AbortController();
    const epoch = generation, load = ++tab.load;
    const valid = () => epoch === generation && tabs.get(key) === tab && tab.load === load && !tab.controller.signal.aborted;
    tab.pane.textContent = "正在读取文件……";
    activate(key);
    tab.promise = (async () => {
      try {
        const data = previewable ? await loadFile(filePath, { signal: tab.controller.signal }) : { path: filePath, kind: "unsupported" };
        if (!valid()) return;
        tab.path = data.path; renderFile(tab, data);
        if (activeKey === key) activate(key); else renderTabs();
      } catch (error) {
        if (!valid()) return;
        tab.pane.textContent = error.message || "文件读取失败";
        const retry = document.createElement("button"); retry.textContent = "重新读取"; retry.type = "button";
        retry.addEventListener("click", () => open(tab.path, { reload: true })); tab.pane.append(retry);
        onError(error);
      }
    })();
    return tab.promise;
  }
  function setWorkspace(key) {
    if (key === workspaceKey) return;
    workspaceKey = key; generation += 1;
    const hadTabs = tabs.size > 0;
    for (const tab of tabs.values()) tab.controller?.abort();
    tabs.clear(); empty();
    if (hadTabs) onNotice("已切换工作区，旧文件标签已关闭");
  }
  return { open, close: closeTab, setWorkspace, activePane: () => tabs.get(activeKey)?.pane || null };
}
