export const VISIBLE_PAGE_SIZE = 50;
export const HISTORY_TOP_THRESHOLD = 80;

// Indexes refer to the displayed message sequence, not conversation turns.
export function createMessageWindow() {
  let messages = [], start = 0, initialized = false;
  return {
    update(next, { reset = true } = {}) {
      if (reset || !initialized || next.length < messages.length) start = Math.max(0, next.length - VISIBLE_PAGE_SIZE);
      initialized = true;
      messages = next;
      return { messages: messages.slice(start), start };
    },
    previous() {
      const end = start;
      start = Math.max(0, start - VISIBLE_PAGE_SIZE);
      return { messages: messages.slice(start, end), start };
    },
    hasPrevious: () => start > 0,
    clear() { messages = []; start = 0; initialized = false; },
  };
}

export function afterHistoryRestore(container, finish) {
  requestAnimationFrame(() => finish(container.scrollTop));
}

export function prependPreviousMessages(window, container, renderItem, afterAppend) {
  const page = window.previous();
  const fragment = document.createDocumentFragment();
  page.messages.forEach((message, index) => fragment.append(renderItem(message, page.start + index)));
  prependPreservingScroll(container, fragment, afterAppend);
}

export function prependPreservingScroll(container, fragment, afterAppend) {
  const anchor = [...(container.children || [])].find((node) => node.getBoundingClientRect().height > 0) || container.firstElementChild;
  const top = anchor?.getBoundingClientRect().top;
  // DOM rectangles include the home canvas CSS zoom; scrollTop does not.
  const canvas = container.closest?.('.app-shell');
  const scale = canvas ? Number.parseFloat(getComputedStyle(canvas).zoom) || 1 : 1;
  const behavior = container.style.scrollBehavior;
  const anchoring = container.style.overflowAnchor;
  container.style.scrollBehavior = 'auto';
  container.style.overflowAnchor = 'none';
  try {
    container.prepend(fragment);
    afterAppend?.();
    if (anchor) container.scrollTop += (anchor.getBoundingClientRect().top - top) / scale;
  } finally {
    container.style.scrollBehavior = behavior;
    container.style.overflowAnchor = anchoring;
  }
}
