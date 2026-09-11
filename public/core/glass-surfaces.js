// Presentation only: classify known overlays and shade only the top modal.
const LARGE = '.ui-dialog,.settings-dialog,.secret-dialog,.workspace-switcher-dialog,.workspace-picker-dialog,.task-summary-dialog,.modal,.chat-history-drawer,.vskill-drawer';
const SMALL = '.model-picker-panel,.task-date-picker,.at-file-menu,.conversation-directory,.work-app-menu';
const MODALS = 'dialog.ui-dialog,dialog.settings-dialog,dialog.secret-dialog,dialog.workspace-switcher-dialog,dialog.workspace-picker-dialog,dialog.task-summary-dialog,dialog.work-app-dialog,.modal-backdrop';
export function installGlassSurfaces() {
  const active = new Map();
  let sequence = 0;
  function classify(root) {
    if (!(root instanceof Element)) return;
    for (const [selector, size] of [[LARGE, 'large'], [SMALL, 'small']]) {
      if (root.matches(selector)) root.dataset.glassSurface = size;
      for (const node of root.querySelectorAll(selector)) node.dataset.glassSurface = size;
    }
  }
  function isOpen(node) {
    return node.isConnected && (node.tagName === 'DIALOG'
      ? node.matches(':modal')
      : !node.hidden && !node.classList.contains('hidden'));
  }
  function sync(records = []) {
    // Attribute records retain opening order even if markup order differs.
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) classify(node);
      if (record.type === 'attributes' && record.target.matches(MODALS)) {
        const node = record.target;
        if (!isOpen(node)) active.delete(node);
        else if (!active.has(node) || record.attributeName === 'open') active.set(node, ++sequence);
      }
    }
    const modals = [...document.querySelectorAll(MODALS)];
    for (const node of modals) {
      if (!isOpen(node)) active.delete(node);
      else if (!active.has(node)) active.set(node, ++sequence);
    }
    for (const node of active.keys()) if (!node.isConnected) active.delete(node);
    const candidates = [...active.keys()];
    const native = candidates.filter((node) => node.tagName === 'DIALOG');
    const top = (native.length ? native : candidates).sort((a, b) => active.get(b) - active.get(a))[0];
    for (const node of modals) node.dataset.glassShade = node === top ? 'active' : 'inactive';
  }
  classify(document.body);
  sync();
  const observer = new MutationObserver((records) => {
    const relevant = records.filter((record) => record.type === 'childList'
      ? [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(`${LARGE},${SMALL},${MODALS}`) || node.querySelector(`${LARGE},${SMALL},${MODALS}`)))
      : record.target.matches(MODALS));
    if (relevant.length) sync(relevant);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] });
  return () => observer.disconnect();
}
if (typeof document !== 'undefined') installGlassSurfaces();
