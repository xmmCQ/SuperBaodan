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
  const scrollTop = container.scrollTop;
  container.prepend(fragment);
  afterAppend?.();
  if (anchor) container.scrollTop = scrollTop + anchor.getBoundingClientRect().top - top;
}
