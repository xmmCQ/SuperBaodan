// Reorder only matching slots; hidden/unrelated records keep their positions.
export function reorderDocumentSlots(items, sourceId, targetId, after, predicate = () => true) {
  const slots = items.map((item, index) => predicate(item) ? index : -1).filter(index => index >= 0);
  const ordered = slots.map(index => items[index]);
  const source = ordered.findIndex(item => item.id === sourceId);
  if (source < 0 || sourceId === targetId || !ordered.some(item => item.id === targetId)) return false;
  const [item] = ordered.splice(source, 1);
  const target = ordered.findIndex(item => item.id === targetId);
  ordered.splice(target + (after ? 1 : 0), 0, item);
  if (slots.every((index, position) => items[index].id === ordered[position].id)) return false;
  slots.forEach((index, position) => { items[index] = ordered[position]; });
  return true;
}
export function documentDragHandle(label) {
  const handle = document.createElement('button');
  handle.type = 'button'; handle.className = 'wd-drag-handle'; handle.draggable = true;
  handle.setAttribute('aria-label', label); handle.title = label;
  handle.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true" fill="currentColor"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg>';
  return handle;
}
export function createDocumentSorter({ container, enabled, context, onMove }) {
  let drag = null, target = null, frame = null;
  const rows = () => [...container.querySelectorAll(':scope > [data-sort-id]')];
  function clearMarks() { for (const row of rows()) row.classList.remove('wd-drop-before', 'wd-drop-after'); }
  function cancel() {
    if (frame != null) cancelAnimationFrame(frame);
    frame = null; drag?.row.classList.remove('wd-dragging'); drag = null; target = null; clearMarks();
    container.classList.remove('wd-sort-active');
  }
  function locate(y) {
    const sourceRect = drag?.row.getBoundingClientRect();
    if (sourceRect && y >= sourceRect.top && y <= sourceRect.bottom) return null;
    const candidates = rows().filter(row => row !== drag?.row);
    const row = candidates.find(row => y < row.getBoundingClientRect().bottom) || candidates.at(-1);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { id: row.dataset.sortId, after: y >= r.top + r.height / 2, row };
  }
  function mark(y) {
    clearMarks(); target = locate(y);
    if (target) target.row.classList.add(target.after ? 'wd-drop-after' : 'wd-drop-before');
  }
  function tick() {
    if (!drag || !enabled() || context() !== drag.context || !drag.row.isConnected) { cancel(); return; }
    if (drag.y != null) {
      const r = container.getBoundingClientRect();
      if (drag.y < r.top + 32) container.scrollTop -= 8;
      else if (drag.y > r.bottom - 32) container.scrollTop += 8;
      mark(drag.y);
    }
    frame = requestAnimationFrame(tick);
  }
  container.addEventListener('dragstart', event => {
    const handle = event.target.closest('.wd-drag-handle');
    const row = handle?.closest('[data-sort-id]');
    if (!row || row.parentElement !== container || !enabled()) { event.preventDefault(); return; }
    cancel(); drag = { row, id: row.dataset.sortId, context: context(), y: null };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-baodan-document-order', drag.id);
    container.classList.add('wd-sort-active');
    row.classList.add('wd-dragging'); frame = requestAnimationFrame(tick);
  });
  function acceptInside(event) {
    if (!drag || !enabled() || context() !== drag.context) return;
    // Accept dragenter too: browsers reset the cursor when entering a child.
    // Capture before links/buttons can interfere with the list's drop effect.
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    drag.y = event.clientY; mark(drag.y);
  }
  container.addEventListener('dragenter', acceptInside, true);
  container.addEventListener('dragover', acceptInside, true);
  container.addEventListener('dragleave', event => {
    if (!drag || container.contains(event.relatedTarget)) return;
    const r = container.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom) return;
    drag.y = null; clearMarks();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  });
  container.addEventListener('drop', event => {
    if (!drag) return;
    event.preventDefault();
    if (!enabled() || context() !== drag.context) { cancel(); return; }
    const from = drag.id, to = locate(event.clientY);
    cancel(); if (to) void onMove(from, to.id, to.after);
  });
  container.addEventListener('click', event => { if (event.target.closest('.wd-drag-handle')) { event.preventDefault(); event.stopPropagation(); } }, true);
  window.addEventListener('dragend', cancel);
  window.addEventListener('blur', cancel);
  return { cancel };
}
