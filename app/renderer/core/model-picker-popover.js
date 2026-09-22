// Native top layer avoids clipping/stacking by the chat pane and composer.
export function bindModelPicker({ button, panel, filter, render }) {
  panel.setAttribute('popover', 'auto');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'false');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '选择模型');
  function position() {
    const box = button.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
    panel.style.bottom = `${window.innerHeight - box.top + 8}px`;
    panel.style.maxHeight = `${Math.max(80, Math.min(480, box.top - 20))}px`;
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
    render(); position(); panel.classList.remove('hidden');
    panel.showPopover(); button.setAttribute('aria-expanded', 'true'); filter.focus();
  });
  panel.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('hidden', !open);
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target === filter) {
      event.preventDefault(); event.stopPropagation(); panel.querySelector('.model-option')?.click(); return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); panel.hidePopover(); button.focus({ preventScroll: true });
  });
  // Existing model switching closes by adding .hidden; preserve that contract.
  new MutationObserver(() => {
    if (panel.classList.contains('hidden') && panel.matches(':popover-open')) panel.hidePopover();
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  filter.addEventListener('input', render);
  window.addEventListener('resize', () => { if (panel.matches(':popover-open')) position(); });
}
