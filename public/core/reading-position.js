const adjustments = new WeakMap();

export function captureReadingPosition(container) {
  if (!container) return null;
  const box = container.getBoundingClientRect();
  const candidates = [...container.querySelectorAll(".markdown-body p, .markdown-body li, .markdown-body tr, .markdown-body pre, .markdown-body h1, .markdown-body h2, .markdown-body h3, .tool-result")];
  const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom; };
  const anchor = candidates.find(visible) || [...container.children].find(visible);
  const rect = anchor?.getBoundingClientRect();
  return {
    top: container.scrollTop, left: container.scrollLeft,
    bottom: container.scrollHeight - container.clientHeight - container.scrollTop < 24,
    anchor, offset: rect ? rect.top - box.top : 0,
    fraction: rect?.height && rect.top < box.top ? (box.top - rect.top) / rect.height : 0,
  };
}

export function restoreReadingPosition(container, position) {
  if (!container || !position || !container.clientHeight) return;
  if (position.bottom) container.scrollTop = container.scrollHeight;
  else if (position.anchor?.isConnected && container.contains(position.anchor)) {
    const rect = position.anchor.getBoundingClientRect();
    const offset = position.fraction ? -position.fraction * rect.height : position.offset;
    container.scrollTop += rect.top - container.getBoundingClientRect().top - offset;
  } else container.scrollTop = position.top;
  container.scrollLeft = position.left;
}

// A continuous resize captures anchors once. Each frame reads geometry in a
// batch, then writes scroll positions; final corrections run only on release.
export function beginReadingResize(containers) {
  const records = [...new Set(containers.filter((node) => node?.clientHeight))].map((node) => {
    const previous = adjustments.get(node);
    return { node, position: captureReadingPosition(node), behavior: previous?.behavior ?? node.style.scrollBehavior, anchorStyle: previous?.anchorStyle ?? node.style.overflowAnchor };
  });
  for (const record of records) {
    adjustments.set(record.node, record);
    record.node.style.scrollBehavior = "auto";
    record.node.style.overflowAnchor = "none";
    record.node.dataset.readingAdjustment = "true";
  }
  const restore = () => {
    const positions = records.filter((record) => adjustments.get(record.node) === record && record.node.clientHeight).map(({ node, position }) => {
      let top = position.top;
      if (position.bottom) top = node.scrollHeight;
      else if (position.anchor?.isConnected && node.contains(position.anchor)) {
        const rect = position.anchor.getBoundingClientRect();
        const offset = position.fraction ? -position.fraction * rect.height : position.offset;
        top = node.scrollTop + rect.top - node.getBoundingClientRect().top - offset;
      }
      return { node, top, left: position.left };
    });
    for (const { node, top, left } of positions) { node.scrollTop = top; node.scrollLeft = left; }
  };
  let finished = false;
  return { restore, finish() {
    if (finished) return;
    finished = true; restore();
    requestAnimationFrame(() => { restore(); requestAnimationFrame(() => {
      restore();
      for (const record of records) {
        if (adjustments.get(record.node) !== record) continue;
        record.node.style.scrollBehavior = record.behavior;
        record.node.style.overflowAnchor = record.anchorStyle;
        delete record.node.dataset.readingAdjustment;
        adjustments.delete(record.node);
      }
    }); });
  } };
}

// Layout changes should not trigger chat pagination or change auto-follow intent.
// Keep anchors through the next paint, coalescing repeated resize frames.
export function preserveReadingPositions(containers, change) {
  const records = [...new Set(containers.filter((node) => node?.clientHeight))].map((node) => {
    const previous = adjustments.get(node);
    const record = { node, position: captureReadingPosition(node), behavior: previous?.behavior ?? node.style.scrollBehavior, anchorStyle: previous?.anchorStyle ?? node.style.overflowAnchor };
    adjustments.set(node, record);
    node.style.scrollBehavior = "auto";
    node.style.overflowAnchor = "none";
    node.dataset.readingAdjustment = "true";
    return record;
  });
  const restore = () => records.forEach((record) => {
    if (adjustments.get(record.node) === record) restoreReadingPosition(record.node, record.position);
  });
  const cleanup = () => records.forEach((record) => {
    if (adjustments.get(record.node) !== record) return;
    record.node.style.scrollBehavior = record.behavior;
    record.node.style.overflowAnchor = record.anchorStyle;
    delete record.node.dataset.readingAdjustment;
    adjustments.delete(record.node);
  });
  try { change(); restore(); }
  catch (error) { cleanup(); throw error; }
  requestAnimationFrame(() => { restore(); requestAnimationFrame(() => { restore(); cleanup(); }); });
}
