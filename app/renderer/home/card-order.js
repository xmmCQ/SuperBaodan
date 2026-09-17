export const CARD_ORDER_PREFIX = 'super-baodan.day-order.v1.';

export function taskOrderKey(task) {
  const text = String(task.editableText ?? task.text ?? '').replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, '').replace(/🔁\s*every\s+(?:day|week|month|year)/gi, '').replace(/\s+/g, ' ').trim();
  const identity = JSON.stringify([task.headingPath || [], task.parentTasks || [], text]);
  // Stable display identity, not a security hash. Do not store task text in preferences.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < identity.length; i++) { a = Math.imul(a ^ identity.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ identity.charCodeAt(i); }
  return `task-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
export function orderedKeys(keys, saved) {
  const rank = new Map(saved.map((key, i) => [key, i]));
  return keys.map((key, i) => ({ key, i })).sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || a.i - b.i).map(({ key }) => key);
}
export function moveOrder(keys, from, target, after) {
  if (from === target || !keys.includes(from) || !keys.includes(target)) return keys.slice();
  const next = keys.filter((key) => key !== from);
  next.splice(next.indexOf(target) + Number(after), 0, from); return next;
}

export function createCardOrder({ container, kind, cardSelector, getDate, keyForItem = (item) => item.id, busy = () => false, onNotice = () => {} }) {
  let date = null, active = false, blocked = false, drag = null, frame = null, keysById = new Map(), items = [];
  const memory = new Map();
  const storageKey = () => `${CARD_ORDER_PREFIX}${kind}.${date}`;
  const cards = () => [...container.children].filter((node) => node.matches(cardSelector));
  const enabled = () => active && date === getDate() && !busy() && !container.closest('.hidden');
  const live = document.createElement('span'); live.className = 'card-order-live'; live.setAttribute('role', 'status'); document.body.append(live);
  function readOrder() {
    const key = storageKey();
    if (memory.has(key)) return memory.get(key);
    try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string'))] : []; }
    catch { return []; }
  }
  function save(order) {
    memory.set(storageKey(), order);
    try { localStorage.setItem(storageKey(), JSON.stringify(order)); }
    catch { onNotice('顺序已调整，但浏览器未允许保存；当前页面仍然有效', true); }
  }
  function identify(values) {
    const counts = new Map(), result = new Map();
    values.map((item, i) => ({ item, i })).sort((a, b) => (a.item.sourceLine ?? a.i) - (b.item.sourceLine ?? b.i)).forEach(({ item }) => {
      const base = keyForItem(item), count = counts.get(base) || 0;
      counts.set(base, count + 1); result.set(item.id, `${base}#${count}`);
    });
    return result;
  }
  function clearMarks() { for (const card of cards()) card.classList.remove('card-order-before', 'card-order-after'); }
  function cancel() {
    if (frame != null) cancelAnimationFrame(frame); frame = null;
    drag?.node.classList.remove('card-order-dragging'); drag = null; clearMarks();
  }
  function place(order, focusKey) {
    const nodes = new Map(cards().map((node) => [node.dataset.cardOrderKey, node]));
    const top = container.scrollTop;
    for (const key of order) if (nodes.has(key)) container.append(nodes.get(key));
    container.scrollTop = top;
    if (focusKey) {
      nodes.get(focusKey)?.focus({ preventScroll: true });
      live.textContent = `已移动到第 ${order.indexOf(focusKey) + 1} 位`;
    }
  }
  function commit(from, target, after) {
    if (!enabled()) return;
    const before = cards().map((node) => node.dataset.cardOrderKey), next = moveOrder(before, from, target, after);
    if (next.every((key, i) => key === before[i])) return;
    place(next, from); save(next);
  }
  function autoscroll() {
    frame = null;
    if (!drag || !drag.node.isConnected || !enabled()) { cancel(); return; }
    if (drag.y != null) {
      const box = container.getBoundingClientRect();
      if (drag.y < box.top + 32) container.scrollTop -= 8;
      else if (drag.y > box.bottom - 32) container.scrollTop += 8;
    }
    frame = requestAnimationFrame(autoscroll);
  }
  function start(event) {
    const node = event.target.closest(cardSelector);
    if (!node || !container.contains(node)) return;
    if (blocked || !enabled()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    // For tasks, let the existing calendar handler also register this drag.
    // The drop target decides whether to reorder or change the date.
    cancel(); drag = { node, key: node.dataset.cardOrderKey, date, y: null };
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-superbaodan-card-order', drag.key);
    const box = node.getBoundingClientRect();
    event.dataTransfer.setDragImage?.(node, Math.max(0, event.clientX - box.left), Math.max(0, event.clientY - box.top));
    node.classList.add('card-order-dragging'); frame = requestAnimationFrame(autoscroll);
  }
  function targetAt(event) {
    const other = cards().filter((node) => node !== drag?.node);
    const node = event.target.closest(cardSelector);
    const target = node && node !== drag?.node && container.contains(node) ? node : other.find((item) => event.clientY < item.getBoundingClientRect().bottom) || other.at(-1);
    if (!target) return null;
    const box = target.getBoundingClientRect(); return { node: target, after: event.clientY >= box.top + box.height / 2 };
  }
  function over(event) {
    if (!drag) return;
    if (!enabled() || !drag.node.isConnected || drag.date !== getDate()) { cancel(); return; }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; drag.y = event.clientY;
    clearMarks(); const target = targetAt(event);
    target?.node.classList.add(target.after ? 'card-order-after' : 'card-order-before');
  }
  function drop(event) {
    if (!drag) return;
    event.preventDefault(); event.stopPropagation();
    const source = drag, target = targetAt(event); cancel();
    if (target && source.date === getDate() && source.node.isConnected) commit(source.key, target.node.dataset.cardOrderKey, target.after);
  }
  function leave(event) {
    if (!drag) return;
    const box = container.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) { drag.y = null; clearMarks(); }
  }
  function keydown(event) {
    const node = event.target.closest(cardSelector);
    if (!node || event.target !== node || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !enabled()) return;
    event.preventDefault(); cancel();
    const list = cards(), index = list.indexOf(node), down = event.key === 'ArrowDown', target = list[index + (down ? 1 : -1)];
    if (target) { commit(node.dataset.cardOrderKey, target.dataset.cardOrderKey, down); node.scrollIntoView({ block: 'nearest' }); }
  }
  const onStorage = (event) => {
    if (event.key === null) memory.clear();
    else if (event.key.startsWith(`${CARD_ORDER_PREFIX}${kind}.`)) memory.delete(event.key);
    else return;
    if (!active || (event.key !== null && event.key !== storageKey())) return;
    cancel();
    if (date === getDate()) place(orderedKeys(cards().map((node) => node.dataset.cardOrderKey), readOrder()));
  };
  const pointerdown = (event) => {
    blocked = Boolean(event.target.closest('button, input, textarea, select, a, [contenteditable="true"]') && !event.target.closest('.daily-record-main'));
  };
  container.addEventListener('pointerdown', pointerdown, true);
  container.addEventListener('dragstart', start, true); container.addEventListener('dragover', over); container.addEventListener('drop', drop); container.addEventListener('dragleave', leave); container.addEventListener('keydown', keydown);
  window.addEventListener('dragend', cancel); window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel); window.addEventListener('storage', onStorage);
  return {
    prepare(values) {
      cancel(); date = getDate(); active = true; items = values.slice(); keysById = identify(items);
      const byKey = new Map(items.map((item) => [keysById.get(item.id), item]));
      return orderedKeys(items.map((item) => keysById.get(item.id)), readOrder()).map((key) => byKey.get(key));
    },
    decorate(values) {
      const nodes = cards();
      nodes.forEach((node, i) => {
        node.dataset.cardOrderKey = keysById.get(values[i].id);
        node.draggable = true; node.tabIndex = 0; node.classList.add('card-order-draggable');
        node.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      });
    },
    rename(previous, next) {
      if (!previous || date !== getDate() || !keysById.has(previous.id)) return;
      const updated = identify(items.map((item) => item.id === previous.id ? next : item));
      const changes = new Map(items.map((item) => [keysById.get(item.id), updated.get(item.id)]));
      const saved = readOrder(); if (saved.length) save(saved.map((key) => changes.get(key) || key));
    },
    disable() { cancel(); active = false; },
    dispose() {
      cancel(); live.remove(); container.removeEventListener('pointerdown', pointerdown, true); container.removeEventListener('dragstart', start, true); container.removeEventListener('dragover', over); container.removeEventListener('drop', drop); container.removeEventListener('dragleave', leave); container.removeEventListener('keydown', keydown);
      window.removeEventListener('dragend', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel); window.removeEventListener('storage', onStorage);
    },
  };
}
