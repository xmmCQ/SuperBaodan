const TOOLTIP_DELAY_MS = 250;
const TOOLTIP_GAP = 9;
const TOOLTIP_EDGE = 8;

let tooltip;
let activeTarget = null;
let showTimer = null;

export function setIconBusy(button, busy) {
  button.toggleAttribute("aria-busy", busy);
  button.disabled = busy;
}

function ensureGlobalTooltip() {
  if (tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.className = "global-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("popover", "manual");
  if (typeof tooltip.showPopover !== "function") tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function scheduleTooltip(target) {
  if (!target?.dataset.tooltip) return;
  clearTimeout(showTimer);
  activeTarget = target;
  showTimer = setTimeout(() => {
    if (activeTarget !== target || !target.isConnected) return;
    showTooltip(target);
  }, TOOLTIP_DELAY_MS);
}

function showTooltip(target) {
  const node = ensureGlobalTooltip();
  node.textContent = target.dataset.tooltip;
  if (typeof node.showPopover === "function") {
    if (!node.matches(":popover-open")) node.showPopover();
  } else {
    node.hidden = false;
  }
  positionTooltip(target);
}

function positionTooltip(target = activeTarget) {
  if (!target?.isConnected || !tooltip || !isTooltipOpen()) return;
  const targetRect = target.getBoundingClientRect();
  if (targetRect.bottom < 0 || targetRect.top > innerHeight || targetRect.right < 0 || targetRect.left > innerWidth) {
    hideTooltip();
    return;
  }
  const tooltipRect = tooltip.getBoundingClientRect();
  const preferDown = target.classList.contains("tooltip-down");
  let top = preferDown ? targetRect.bottom + TOOLTIP_GAP : targetRect.top - tooltipRect.height - TOOLTIP_GAP;
  const downFits = targetRect.bottom + TOOLTIP_GAP + tooltipRect.height <= innerHeight - TOOLTIP_EDGE;
  const upFits = targetRect.top - TOOLTIP_GAP - tooltipRect.height >= TOOLTIP_EDGE;
  if (preferDown && !downFits && upFits) top = targetRect.top - tooltipRect.height - TOOLTIP_GAP;
  if (!preferDown && !upFits && downFits) top = targetRect.bottom + TOOLTIP_GAP;
  let left = target.classList.contains("tooltip-left")
    ? targetRect.right - tooltipRect.width
    : targetRect.left + (targetRect.width - tooltipRect.width) / 2;
  if (target.classList.contains("tooltip-side-left")) {
    left = targetRect.left - tooltipRect.width - TOOLTIP_GAP;
    top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
  }
  left = Math.min(Math.max(TOOLTIP_EDGE, left), innerWidth - tooltipRect.width - TOOLTIP_EDGE);
  top = Math.min(Math.max(TOOLTIP_EDGE, top), innerHeight - tooltipRect.height - TOOLTIP_EDGE);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip(target = null) {
  if (target && activeTarget !== target) return;
  clearTimeout(showTimer);
  showTimer = null;
  activeTarget = null;
  if (!tooltip || !isTooltipOpen()) return;
  if (typeof tooltip.hidePopover === "function") tooltip.hidePopover();
  else tooltip.hidden = true;
}

function isTooltipOpen() {
  return typeof tooltip.showPopover === "function" ? tooltip.matches(":popover-open") : !tooltip.hidden;
}

function tooltipTarget(node) {
  return node instanceof Element ? node.closest("[data-tooltip]") : null;
}

document.addEventListener("pointerover", (event) => scheduleTooltip(tooltipTarget(event.target)));
document.addEventListener("pointerout", (event) => {
  const target = tooltipTarget(event.target);
  if (!target || target.contains(event.relatedTarget) || document.activeElement === target) return;
  hideTooltip(target);
});
document.addEventListener("focusin", (event) => scheduleTooltip(tooltipTarget(event.target)));
document.addEventListener("focusout", (event) => hideTooltip(tooltipTarget(event.target)));
document.addEventListener("pointerdown", () => hideTooltip());
document.addEventListener("scroll", () => positionTooltip(), true);
window.addEventListener("resize", () => positionTooltip());
