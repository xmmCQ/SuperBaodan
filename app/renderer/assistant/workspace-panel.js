import { beginReadingResize, captureReadingPosition, preserveReadingPositions, restoreReadingPosition } from "../core/reading-position.js";

export const PANEL_WIDTH_KEY = "super-baodan.file-panel-width.v1";
export const PANEL_DEFAULT_WIDTH = 330;
export function panelBounds(totalWidth, sidebarWidth) {
  const max = Math.max(0, Math.min(960, totalWidth - sidebarWidth - 520));
  return { min: Math.min(280, max), max };
}
export function clampPanelWidth(value, bounds) {
  const number = Number(value);
  return Math.max(bounds.min, Math.min(bounds.max, Number.isFinite(number) && number > 0 ? number : PANEL_DEFAULT_WIDTH));
}

export function createWorkspacePanel({ shell, panel, separator, expandButton, treeButton, chat, getPreviewContainer }) {
  const sidebar = shell.querySelector(".sidebar");
  let preferred = PANEL_DEFAULT_WIDTH, expanded = false, drag = null, frame = null, closedPosition = null;
  try { preferred = Number(localStorage.getItem(PANEL_WIDTH_KEY)) || PANEL_DEFAULT_WIDTH; } catch {}
  const bounds = () => panelBounds(shell.clientWidth, sidebar.getBoundingClientRect().width);
  const setLabel = (node, text) => { node.title = text; node.setAttribute("aria-label", text); node.dataset.tooltip = text; };
  function save() { try { localStorage.setItem(PANEL_WIDTH_KEY, String(preferred)); } catch {} }
  function apply(limits = bounds()) {
    const width = expanded ? limits.max : clampPanelWidth(preferred, limits);
    shell.style.setProperty("--file-panel-width", `${width}px`);
    shell.classList.toggle("preview-expanded", expanded);
    separator.setAttribute("aria-valuemin", String(Math.round(limits.min)));
    separator.setAttribute("aria-valuemax", String(Math.round(limits.max)));
    separator.setAttribute("aria-valuenow", String(Math.round(width)));
    expandButton.setAttribute("aria-pressed", String(expanded));
    setLabel(expandButton, expanded ? "退出放大预览" : "放大预览");
    expandButton.querySelector("use")?.setAttribute("href", `/icons.svg#${expanded ? "minimize-2" : "maximize-2"}`);
  }
  const adjust = (operation) => preserveReadingPositions([chat, getPreviewContainer()], () => { operation(); apply(); });
  function resize(value, persist = false) {
    adjust(() => { expanded = false; preferred = clampPanelWidth(value, bounds()); });
    if (persist) save();
  }
  function flushDrag() {
    if (frame != null) cancelAnimationFrame(frame);
    frame = null;
    if (drag?.pending == null) return;
    const width = Math.round(clampPanelWidth(drag.pending, drag.limits));
    drag.pending = null;
    if (width === drag.lastWidth) return;
    preferred = width; drag.lastWidth = width;
    if (expanded) { expanded = false; apply(drag.limits); }
    else shell.style.setProperty("--file-panel-width", `${width}px`);
    drag.reading.restore();
  }
  function finish() {
    if (!drag) return;
    flushDrag();
    const current = drag; drag = null;
    shell.classList.remove("workspace-resizing");
    document.body.style.cursor = current.cursor;
    document.body.style.userSelect = current.userSelect;
    apply(); current.reading.finish();
    try { if (separator.hasPointerCapture(current.pointerId)) separator.releasePointerCapture(current.pointerId); } catch {}
    save();
  }
  separator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || shell.classList.contains("workspace-closed")) return;
    event.preventDefault(); finish();
    const width = panel.getBoundingClientRect().width;
    drag = { pointerId: event.pointerId, startX: event.clientX, width, lastWidth: width, limits: bounds(), reading: beginReadingResize([chat, getPreviewContainer()]), cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    shell.classList.add("workspace-resizing");
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    try { separator.setPointerCapture(event.pointerId); } catch { /* Window listeners still guarantee cleanup. */ }
  });
  const move = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { finish(); return; }
    drag.pending = drag.width + drag.startX - event.clientX;
    if (frame == null) frame = requestAnimationFrame(flushDrag);
  };
  const release = (event) => { if (drag && event.pointerId === drag.pointerId) finish(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release);
  window.addEventListener("blur", finish); separator.addEventListener("lostpointercapture", release);
  separator.addEventListener("dblclick", () => { finish(); resize(PANEL_DEFAULT_WIDTH, true); });
  separator.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault(); finish();
    resize(event.key === "Home" ? PANEL_DEFAULT_WIDTH : panel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20), true);
  });
  expandButton.addEventListener("click", () => { if (!getPreviewContainer()) return; finish(); adjust(() => { expanded = !expanded; }); });
  let treeCollapsed = false;
  try { treeCollapsed = localStorage.getItem("super-baodan.file-tree-collapsed.v1") === "true"; } catch {}
  function applyTree() {
    panel.classList.toggle("tree-collapsed", treeCollapsed);
    treeButton.setAttribute("aria-expanded", String(!treeCollapsed));
    setLabel(treeButton, treeCollapsed ? "展开文件树" : "折叠文件树");
    treeButton.textContent = treeCollapsed ? "▸" : "▾";
  }
  treeButton.addEventListener("click", () => {
    preserveReadingPositions([getPreviewContainer()], () => { treeCollapsed = !treeCollapsed; applyTree(); });
    try { localStorage.setItem("super-baodan.file-tree-collapsed.v1", String(treeCollapsed)); } catch {}
  });
  const observer = new ResizeObserver(() => {
    if (!drag) { adjust(() => {}); return; }
    drag.limits = bounds();
    if (drag.pending == null) drag.pending = drag.lastWidth;
    if (frame == null) frame = requestAnimationFrame(flushDrag);
  });
  observer.observe(shell);
  const sidebarChanged = () => { finish(); adjust(() => {}); };
  shell.addEventListener('sidebar-resized', sidebarChanged);
  function setOpen(open) {
    finish();
    const wasOpen = !shell.classList.contains("workspace-closed");
    if (wasOpen === open) return;
    if (!open) closedPosition = captureReadingPosition(getPreviewContainer());
    preserveReadingPositions([chat], () => {
      shell.classList.toggle("workspace-closed", !open);
      if (!open) expanded = false;
      apply();
      if (open) restoreReadingPosition(getPreviewContainer(), closedPosition);
    });
  }
  applyTree(); apply();
  function dispose() {
    finish(); observer.disconnect(); shell.removeEventListener('sidebar-resized', sidebarChanged);
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("blur", finish);
  }
  window.addEventListener("pagehide", (event) => { if (event.persisted) finish(); else dispose(); });
  return { setOpen, exitExpanded() { if (expanded) adjust(() => { expanded = false; }); }, dispose };
}
