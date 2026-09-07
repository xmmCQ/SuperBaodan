export function createWorkspaceController({
  state,
  elements: el,
  api,
  workspaceUrl,
  workspacePayload,
  setIconBusy,
  uiDialogs,
  createMarkdownArticle,
  showNotice,
  showError,
  resizePrompt,
  loadBootstrap
}) {
function toggleWorkspace() {
  setWorkspaceOpen(document.querySelector(".assistant-shell").classList.contains("workspace-closed"));
}

function setWorkspaceOpen(open) {
  document.querySelector(".assistant-shell").classList.toggle("workspace-closed", !open);
  if (open) void loadWorkspaceTree();
}

function refreshWorkspaceTreeIfOpen() {
  return document.querySelector(".assistant-shell").classList.contains("workspace-closed")
    ? Promise.resolve()
    : loadWorkspaceTree();
}

async function loadWorkspaceTree() {
  setIconBusy(el.refreshWorkspace, true);
  try {
    const data = await api(workspaceUrl("/api/workspace/tree?depth=4"));
    el.workspaceTree.replaceChildren(renderTreeEntries(data.entries || [], true));
  } catch (error) {
    el.workspaceTree.textContent = error.message;
  } finally {
    setIconBusy(el.refreshWorkspace, false);
  }
}

async function uploadWorkspaceFiles() {
  const files = [...el.workspaceUploadInput.files];
  el.workspaceUploadInput.value = "";
  if (!files.length) return;
  const originalTooltip = el.uploadWorkspace.dataset.tooltip;
  const uploaded = [];
  const errors = [];
  el.workspaceUploadInput.disabled = true;
  setIconBusy(el.uploadWorkspace, true);
  try {
    const check = await api("/api/workspace/upload/check", {
      method: "POST",
      body: JSON.stringify(workspacePayload({ directory: "", files: files.map((file) => ({ name: file.name, size: file.size })) })),
    });
    const blocked = (check.conflicts || []).filter((item) => item.kind !== "file");
    if (blocked.length) throw new Error(`存在不可覆盖的同名${blocked[0].kind === "directory" ? "目录" : "符号链接"}：${blocked.map((item) => item.name).join("、")}`);
    let overwrite = false;
    let selected = files;
    const conflicts = new Set((check.conflicts || []).map((item) => item.name.toLocaleLowerCase()));
    if (conflicts.size) {
      const choice = await uiDialogs.select("发现同名文件", [
        { value: "overwrite", label: "覆盖同名文件" },
        { value: "skip", label: "跳过同名文件" },
      ], {
        message: `以下文件已存在：\n${[...check.conflicts].map((item) => item.name).join("\n")}`,
        confirmText: "继续上传",
      });
      if (choice == null) return;
      overwrite = choice === "overwrite";
      if (choice === "skip") selected = files.filter((file) => !conflicts.has(file.name.toLocaleLowerCase()));
    }
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      const progress = `上传中 ${index + 1}/${selected.length}`;
      el.uploadWorkspace.dataset.tooltip = progress;
      el.uploadWorkspace.setAttribute("aria-label", progress);
      try {
        const data = await api(workspaceUrl(`/api/workspace/upload?name=${encodeURIComponent(file.name)}&overwrite=${overwrite}`), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        uploaded.push(data.uploaded);
      } catch (error) {
        errors.push(`${file.name}：${error.message}`);
      }
    }
    if (uploaded.length) {
      await loadWorkspaceTree();
      await selectWorkspaceFile(uploaded[0]);
    }
    const skipped = files.length - selected.length;
    const summary = [`已上传 ${uploaded.length} 个文件`];
    if (skipped) summary.push(`跳过 ${skipped} 个`);
    if (errors.length) summary.push(`失败 ${errors.length} 个：${errors.join("；")}`);
    showNotice(summary.join("，"), Boolean(errors.length));
  } catch (error) {
    showError(error);
  } finally {
    el.workspaceUploadInput.disabled = false;
    el.uploadWorkspace.dataset.tooltip = originalTooltip;
    el.uploadWorkspace.setAttribute("aria-label", "上传文件到工作区根目录");
    setIconBusy(el.uploadWorkspace, false);
  }
}

function renderTreeEntries(entries, root = false) {
  const list = document.createElement("ul");
  list.className = `tree-list${root ? " root" : ""}`;
  for (const entry of entries) {
    const item = document.createElement("li"); item.className = "tree-entry";
    const label = document.createElement("button");
    label.className = "tooltip-control tooltip-left";
    label.dataset.tooltip = entry.path;
    if (entry.kind === "directory") {
      const children = renderTreeEntries(entry.children || []);
      label.textContent = `▾ ${entry.name}`;
      label.setAttribute("aria-expanded", "true");
      label.addEventListener("click", () => {
        const expanded = label.getAttribute("aria-expanded") === "true";
        label.setAttribute("aria-expanded", String(!expanded));
        label.textContent = `${expanded ? "▸" : "▾"} ${entry.name}`;
        children.classList.toggle("hidden", expanded);
      });
      item.append(label, children);
    } else {
      label.textContent = `${entry.kind === "symlink" ? "↗" : "·"} ${entry.name}`;
      if (entry.kind === "file") label.addEventListener("click", () => selectWorkspaceFile(entry));
      else label.disabled = true;
      item.append(label);
    }
    list.append(item);
  }
  return list;
}

async function searchWorkspaceFiles() {
  const query = el.workspaceSearch.value.trim();
  if (!query) { el.workspaceSearchResults.classList.add("hidden"); return; }
  try {
    const data = await api(workspaceUrl(`/api/workspace/search?q=${encodeURIComponent(query)}`));
    renderWorkspaceSearchResults(data.results || [], false);
  } catch (error) { showError(error); }
}

function renderWorkspaceSearchResults(results, insertMode) {
  const container = insertMode ? el.atFileMenu : el.workspaceSearchResults;
  container.replaceChildren();
  for (const file of results) {
    const button = document.createElement("button"); button.className = "tooltip-control tooltip-left"; button.textContent = file.path; button.dataset.tooltip = file.path;
    button.addEventListener("click", () => insertMode ? insertFileReference(file.path) : selectWorkspaceFile(file));
    container.append(button);
  }
  if (!results.length) { const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "没有匹配文件"; container.append(empty); }
  container.classList.remove("hidden");
}

async function selectWorkspaceFile(file) {
  if (file.previewable !== false) return previewWorkspaceFile(file.path);
  state.previewPath = file.path;
  el.previewTitle.textContent = file.path;
  el.insertPreviewPath.classList.remove("hidden");
  el.filePreview.className = "file-preview muted";
  el.filePreview.textContent = "此文件不能在页面中预览，可插入 @路径让宝蛋读取处理。";
}

async function previewWorkspaceFile(filePath) {
  try {
    const data = await api(workspaceUrl(`/api/workspace/preview?path=${encodeURIComponent(filePath)}`));
    state.previewPath = data.path;
    el.previewTitle.textContent = data.path;
    el.insertPreviewPath.classList.remove("hidden");
    el.filePreview.replaceChildren();
    el.filePreview.className = "file-preview";
    if (["text", "code"].includes(data.kind)) {
      const pre = document.createElement("pre"); pre.textContent = data.content; el.filePreview.append(pre);
    } else if (data.kind === "markdown") {
      el.filePreview.append(createMarkdownArticle(data.content, { onNotice: showNotice }));
    } else if (data.kind === "image") {
      const image = document.createElement("img"); image.src = workspaceUrl(data.contentUrl); image.alt = data.path; el.filePreview.append(image);
    } else if (data.kind === "pdf") {
      const frame = document.createElement("iframe"); frame.src = workspaceUrl(data.contentUrl); frame.title = data.path; el.filePreview.append(frame);
    }
  } catch (error) { showError(error); }
}

function renderTurnFiles() {
  const involved = state.turnFiles.involved || [];
  const modified = new Set(state.turnFiles.modified || []);
  el.turnFiles.replaceChildren();
  el.turnFiles.className = involved.length ? "turn-files" : "turn-files muted";
  if (!involved.length) { el.turnFiles.textContent = "本轮尚未涉及文件"; return; }
  const summary = document.createElement("div"); summary.textContent = `涉及 ${involved.length} · 修改 ${modified.size}`;
  const list = document.createElement("div"); list.className = "turn-file-list";
  for (const file of involved) {
    const button = document.createElement("button"); button.className = `turn-file${modified.has(file) ? " modified" : ""}`; button.textContent = file;
    button.addEventListener("click", () => previewWorkspaceFile(file)); list.append(button);
  }
  el.turnFiles.append(summary, list);
}

function handlePromptInput() {
  resizePrompt();
  clearTimeout(state.atSearchTimer);
  const beforeCursor = el.promptInput.value.slice(0, el.promptInput.selectionStart);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]{1,100})$/);
  if (!match) { el.atFileMenu.classList.add("hidden"); return; }
  state.atSearchTimer = setTimeout(async () => {
    try {
      const data = await api(workspaceUrl(`/api/workspace/search?q=${encodeURIComponent(match[1])}`));
      renderWorkspaceSearchResults(data.results || [], true);
    } catch { el.atFileMenu.classList.add("hidden"); }
  }, 120);
}

function insertFileReference(filePath) {
  if (!filePath) return;
  const input = el.promptInput;
  const cursor = input.selectionStart;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@[^\s@]*$/);
  const start = match ? before.lastIndexOf("@") : cursor;
  const reference = `@${filePath}`;
  input.setRangeText(`${reference} `, start, cursor, "end");
  el.atFileMenu.classList.add("hidden");
  input.focus(); resizePrompt();
}

function scheduleWorkspaceReload(message = "") {
  clearTimeout(state.workspaceReloadTimer);
  state.workspaceReloadTimer = setTimeout(async () => {
    await loadBootstrap();
    if (message) showNotice(message);
  }, 80);
}
  function setWorkspace(workspace) { state.workspace = workspace; if (workspace) el.workspacePanelTitle.textContent = workspace.name; }
  function workspace() { return state.workspace; }
  function setTurnFiles(files) { state.turnFiles = files || { involved: [], modified: [] }; renderTurnFiles(); }
  function turnFiles() { return state.turnFiles; }
  return { setWorkspace, workspace, setTurnFiles, turnFiles, toggleWorkspace, setWorkspaceOpen, refreshWorkspaceTreeIfOpen, loadWorkspaceTree, uploadWorkspaceFiles, renderTreeEntries, searchWorkspaceFiles, renderWorkspaceSearchResults, selectWorkspaceFile, previewWorkspaceFile, renderTurnFiles, handlePromptInput, insertFileReference, scheduleWorkspaceReload };
}
