import { beginReadingResize, preserveReadingPositions } from "../core/reading-position.js";

export const SIDEBAR_WIDTH_KEY = "super-baodan.sidebar-width.v1";
export const SIDEBAR_DEFAULT_WIDTH = 195;
export function sidebarBounds(total, fileWidth) {
  const max = Math.max(0, Math.min(420, total - fileWidth - 520));
  return { min: Math.min(180, max), max };
}
export function clampSidebarWidth(value, limits) {
  const number = Number(value);
  return Math.max(limits.min, Math.min(limits.max, Number.isFinite(number) ? number : SIDEBAR_DEFAULT_WIDTH));
}

export function createSidebarResize({ shell, sidebar, separator, panel, chat, getPreviewContainer }) {
  let preferred = SIDEBAR_DEFAULT_WIDTH, drag = null, frame = null;
  try { preferred = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT_WIDTH; } catch {}
  const bounds = () => sidebarBounds(shell.clientWidth, shell.classList.contains('workspace-closed') ? 0 : panel.getBoundingClientRect().width);
  const containers = () => [chat, getPreviewContainer()];
  const notify = () => shell.dispatchEvent(new Event('sidebar-resized'));
  const save = () => { try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(preferred)); } catch {} };
  function apply() {
    const limits = bounds(), width = clampSidebarWidth(preferred, limits);
    shell.style.setProperty('--sidebar-width', `${width}px`);
    separator.setAttribute('aria-valuemin', String(Math.round(limits.min)));
    separator.setAttribute('aria-valuemax', String(Math.round(limits.max)));
    separator.setAttribute('aria-valuenow', String(Math.round(width)));
  }
  function flush() {
    if (frame != null) cancelAnimationFrame(frame);
    frame = null;
    if (drag?.pending == null) return;
    const width = clampSidebarWidth(Math.round(drag.pending), drag.limits); drag.pending = null;
    if (width === drag.lastWidth) return;
    preferred = width; drag.lastWidth = width;
    shell.style.setProperty('--sidebar-width', `${width}px`);
    drag.reading.restore();
  }
  function finish() {
    if (!drag) return;
    flush(); const previous = drag; drag = null;
    shell.classList.remove('sidebar-resizing');
    document.body.style.cursor = previous.cursor; document.body.style.userSelect = previous.userSelect;
    try { if (separator.hasPointerCapture(previous.pointerId)) separator.releasePointerCapture(previous.pointerId); } catch {}
    apply(); previous.reading.finish(); save(); notify();
  }
  function start(event) {
    if (event.button !== 0) return;
    event.preventDefault(); finish();
    const width = sidebar.getBoundingClientRect().width;
    drag = { pointerId: event.pointerId, startX: event.clientX, width, lastWidth: width, limits: bounds(), reading: beginReadingResize(containers()), cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    shell.classList.add('sidebar-resizing');
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    try { separator.setPointerCapture(event.pointerId); } catch {}
  }
  function move(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) { finish(); return; }
    drag.pending = drag.width + event.clientX - drag.startX;
    if (frame == null) frame = requestAnimationFrame(flush);
  }
  const release = (event) => { if (drag?.pointerId === event.pointerId) finish(); };
  const resize = (width) => {
    finish();
    preserveReadingPositions(containers(), () => { preferred = clampSidebarWidth(width, bounds()); apply(); notify(); });
    save();
  };
  const reset = () => resize(SIDEBAR_DEFAULT_WIDTH);
  const key = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); resize(event.key === 'Home' ? SIDEBAR_DEFAULT_WIDTH : sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20));
  };
  separator.addEventListener('pointerdown', start); separator.addEventListener('lostpointercapture', release);
  separator.addEventListener('dblclick', reset); separator.addEventListener('keydown', key);
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); window.addEventListener('blur', finish);
  const observer = new ResizeObserver(() => {
    finish();
    const width = clampSidebarWidth(preferred, bounds());
    if (Math.abs(sidebar.getBoundingClientRect().width - width) < 0.5) { apply(); return; }
    preserveReadingPositions(containers(), () => { apply(); notify(); });
  });
  observer.observe(shell); apply(); notify();
  function dispose() {
    finish(); observer.disconnect();
    separator.removeEventListener('pointerdown', start); separator.removeEventListener('lostpointercapture', release);
    separator.removeEventListener('dblclick', reset); separator.removeEventListener('keydown', key);
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); window.removeEventListener('blur', finish);
  }
  window.addEventListener('pagehide', (event) => { if (event.persisted) finish(); else dispose(); });
  return { dispose };
}
