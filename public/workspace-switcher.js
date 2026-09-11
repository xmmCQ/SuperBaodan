export function createWorkspaceSwitcher({ trigger, api, uiDialogs, showPathTooltip = true, hasDraft = () => false, getDraftWarning = () => '切换工作区将清空当前未发送的内容。', clearDraft = () => {}, onActivated = async () => {}, onError = console.error }) {
  let data = { activeWorkspaceId: null, items: [] };
  const manager = buildManagerDialog();
  const picker = buildPickerDialog();
  document.body.append(manager.dialog, picker.dialog);

  trigger.addEventListener("click", async () => {
    try { await load(); manager.dialog.showModal(); manager.search.focus(); }
    catch (error) { onError(error); }
  });
  manager.close.addEventListener("click", () => manager.dialog.close());
  manager.add.addEventListener("click", openPicker);
  manager.search.addEventListener("input", render);
  manager.dialog.addEventListener("click", (event) => { if (event.target === manager.dialog) manager.dialog.close(); });
  picker.close.addEventListener("click", () => picker.dialog.close());
  picker.cancel.addEventListener("click", () => picker.dialog.close());
  picker.up.addEventListener("click", () => browse(picker.parentPath || ""));
  picker.go.addEventListener("click", () => browse(picker.path.value));
  picker.name.addEventListener("input", () => { picker.nameEdited = true; });
  picker.path.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void browse(picker.path.value); } });
  picker.form.addEventListener("submit", addWorkspace);

  async function load() {
    data = await api("/api/workspaces");
    updateTrigger();
    render();
    return data;
  }

  function sync(payload) {
    if (payload?.items) data = payload;
    if (payload?.workspace) {
      data.activeWorkspaceId = payload.workspace.id;
      const index = data.items.findIndex((item) => item.id === payload.workspace.id);
      if (index >= 0) data.items[index] = { ...data.items[index], ...payload.workspace };
      else data.items.unshift(payload.workspace);
    }
    updateTrigger();
    render();
  }

  function active() { return data.items.find((item) => item.id === data.activeWorkspaceId) || null; }

  function updateTrigger() {
    const item = active();
    const label = trigger.querySelector("[data-workspace-label]");
    if (label) label.textContent = item?.name || "选择工作区";
    if (showPathTooltip) trigger.dataset.tooltip = item?.root || "选择工作区";
    else trigger.removeAttribute("data-tooltip");
    trigger.removeAttribute("title");
  }

  function render() {
    const query = manager.search.value.trim().toLocaleLowerCase();
    const items = data.items.filter((item) => `${item.name} ${item.root}`.toLocaleLowerCase().includes(query));
    manager.list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "workspace-switcher-empty";
      empty.textContent = query ? "没有匹配的工作区" : "尚未添加工作区";
      manager.list.append(empty);
      return;
    }
    for (const item of items) manager.list.append(workspaceRow(item));
  }

  function workspaceRow(item) {
    const row = document.createElement("article");
    row.className = `workspace-switcher-row${item.id === data.activeWorkspaceId ? " active" : ""}${item.available === false ? " unavailable" : ""}`;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "workspace-switcher-main";
    main.disabled = item.id === data.activeWorkspaceId || item.available === false;
    const title = document.createElement("strong");
    title.textContent = item.name;
    const path = document.createElement("span");
    path.textContent = item.root;
    const status = document.createElement("small");
    status.textContent = item.id === data.activeWorkspaceId ? "当前工作区" : item.available === false ? "目录不可用" : "切换";
    main.append(title, path, status);
    main.addEventListener("click", () => activate(item));
    const actions = document.createElement("div");
    actions.className = "workspace-switcher-actions";
    const rename = actionButton("重命名", "pencil", () => renameWorkspace(item));
    actions.append(rename);
    if (!item.isDefault) actions.append(actionButton("移除", "trash-2", () => removeWorkspace(item), "danger"));
    row.append(main, actions);
    return row;
  }

  async function activate(item) {
    if (hasDraft()) {
      const confirmed = await uiDialogs.confirm(getDraftWarning(), { title: "切换工作区", confirmText: "清空并切换" });
      if (!confirmed) return;
    }
    manager.dialog.classList.add("busy");
    try {
      const result = await api(`/api/workspaces/${encodeURIComponent(item.id)}/activate`, { method: "POST", body: JSON.stringify({}) });
      clearDraft();
      sync({ workspace: result.workspace });
      manager.dialog.close();
      await onActivated(result);
    } catch (error) { onError(error); }
    finally { manager.dialog.classList.remove("busy"); }
  }

  async function renameWorkspace(item) {
    const name = await uiDialogs.prompt("重命名工作区", item.name, { message: "工作区名称", placeholder: "输入名称" });
    if (name == null || name.trim() === item.name) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
      await load();
    } catch (error) { onError(error); }
  }

  async function removeWorkspace(item) {
    const confirmed = await uiDialogs.confirm(`仅从超级宝蛋中移除“${item.name}”，不会删除磁盘文件和历史会话。`, { title: "移除工作区", danger: true, confirmText: "移除" });
    if (!confirmed) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({}) });
      await load();
    } catch (error) { onError(error); }
  }

  async function openPicker() {
    picker.nameEdited = false;
    picker.name.value = "";
    picker.path.value = active()?.root || "";
    picker.dialog.showModal();
    await browse(picker.path.value).catch(onError);
  }

  async function browse(candidate) {
    picker.list.textContent = "正在读取……";
    const result = await api(`/api/workspaces/browse${candidate ? `?path=${encodeURIComponent(candidate)}` : ""}`);
    picker.currentPath = result.path || "";
    picker.parentPath = result.parentPath;
    picker.path.value = result.path || "";
    picker.up.disabled = result.parentPath == null;
    picker.list.replaceChildren();
    const entries = result.drives ?? result.directories ?? [];
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "workspace-switcher-empty";
      empty.textContent = "没有可浏览的子目录";
      picker.list.append(empty);
    }
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-directory-entry";
      button.textContent = entry.name;
      button.dataset.tooltip = entry.path;
      button.addEventListener("click", () => browse(entry.path).catch(onError));
      picker.list.append(button);
    }
    if (!picker.nameEdited && result.path) picker.name.value = basename(result.path);
  }

  async function addWorkspace(event) {
    event.preventDefault();
    const name = picker.name.value.trim();
    const selectedPath = picker.path.value.trim();
    if (!name || !selectedPath) return;
    picker.dialog.classList.add("busy");
    try {
      const created = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ name, path: selectedPath }) });
      picker.dialog.close();
      await load();
      await activate(created.workspace);
    } catch (error) { onError(error); }
    finally { picker.dialog.classList.remove("busy"); }
  }

  return { load, sync, active, get data() { return data; } };
}

function actionButton(label, icon, handler, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `workspace-switcher-action icon-action tooltip-left${variant === "danger" ? " danger icon-danger" : ""}`;
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  button.innerHTML = iconSvg(icon);
  button.addEventListener("click", handler);
  return button;
}

function iconSvg(icon) {
  return `<svg aria-hidden="true"><use href="/icons.svg?v=4#${icon}"></use></svg>`;
}

function buildManagerDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-switcher-dialog";
  dialog.innerHTML = `<div class="workspace-switcher-head"><div><strong>工作区</strong><span>切换后恢复该工作区的会话与文件</span></div><button class="icon-action tooltip-left" type="button" data-close aria-label="关闭" data-tooltip="关闭">${iconSvg("x")}</button></div><div class="workspace-switcher-toolbar"><input type="search" placeholder="搜索名称或路径" autocomplete="off"><button class="icon-action assistant-primary tooltip-left" type="button" data-add aria-label="添加工作区" data-tooltip="添加工作区">${iconSvg("plus")}</button></div><div class="workspace-switcher-list"></div>`;
  return { dialog, close: dialog.querySelector("[data-close]"), add: dialog.querySelector("[data-add]"), search: dialog.querySelector("input"), list: dialog.querySelector(".workspace-switcher-list") };
}

function buildPickerDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-picker-dialog";
  dialog.innerHTML = `<form><div class="workspace-switcher-head"><div><strong>添加工作区</strong><span>选择本机文件夹</span></div><button class="icon-action tooltip-left" type="button" data-close aria-label="关闭" data-tooltip="关闭">${iconSvg("x")}</button></div><label>工作区名称<input name="name" maxlength="60" required></label><label>目录路径<div class="workspace-picker-path"><button class="icon-action tooltip-down" type="button" data-up aria-label="上一级" data-tooltip="上一级">${iconSvg("arrow-up")}</button><input name="path" required><button class="icon-action tooltip-down" type="button" data-go aria-label="进入目录" data-tooltip="进入目录">${iconSvg("chevron-right")}</button></div></label><div class="workspace-directory-list"></div><div class="workspace-picker-footer"><button class="icon-action" type="button" data-cancel aria-label="取消" data-tooltip="取消">${iconSvg("x")}</button><button type="submit" class="primary icon-action assistant-primary" aria-label="添加并切换" data-tooltip="添加并切换">${iconSvg("check")}</button></div></form>`;
  return { dialog, form: dialog.querySelector("form"), close: dialog.querySelector("[data-close]"), cancel: dialog.querySelector("[data-cancel]"), up: dialog.querySelector("[data-up]"), go: dialog.querySelector("[data-go]"), name: dialog.querySelector('[name="name"]'), path: dialog.querySelector('[name="path"]'), list: dialog.querySelector(".workspace-directory-list"), currentPath: "", parentPath: null, nameEdited: false };
}

function basename(value) {
  return String(value).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "工作区";
}
