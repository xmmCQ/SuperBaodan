export function normalizeWindowState(saved, displays, primaryDisplay) {
  const primary = primaryDisplay?.workArea || displays[0]?.workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const valid = validBounds(saved?.bounds);
  const target = valid ? closestDisplay(saved.bounds, displays)?.workArea || primary : primary;
  const minimumWidth = Math.min(960, target.width);
  const minimumHeight = Math.min(640, target.height);
  const width = clamp(valid ? saved.bounds.width : 1280, minimumWidth, target.width);
  const height = clamp(valid ? saved.bounds.height : 840, minimumHeight, target.height);
  if (!valid) return { bounds: centered(target, width, height), maximized: false, minimumWidth, minimumHeight };
  const x = clamp(saved.bounds.x, target.x, target.x + target.width - width);
  const y = clamp(saved.bounds.y, target.y, target.y + target.height - height);
  return { bounds: { x, y, width, height }, maximized: Boolean(saved.maximized), minimumWidth, minimumHeight };
}

export function validBounds(bounds) {
  return Boolean(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0);
}

function closestDisplay(bounds, displays) {
  if (!displays.length) return null;
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + Math.min(32, bounds.height / 2) };
  return displays.reduce((best, display) => distanceSquared(point, display.workArea) < distanceSquared(point, best.workArea) ? display : best);
}

function distanceSquared(point, area) {
  const x = clamp(point.x, area.x, area.x + area.width);
  const y = clamp(point.y, area.y, area.y + area.height);
  return (point.x - x) ** 2 + (point.y - y) ** 2;
}

function centered(area, width, height) {
  return { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
}

function clamp(value, minimum, maximum) { return Math.min(Math.max(value, minimum), Math.max(minimum, maximum)); }
