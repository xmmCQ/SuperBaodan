export const BASELINE_KEY = 'super-baodan:home-design-baseline:v1';
export const DEFAULT_BASELINE = Object.freeze({ width: 1463, height: 800 });
export function fitHomeCanvas(width, height, baseline) {
  return Math.min(width / baseline.width, height / baseline.height);
}
function validBaseline(value) {
  return value && Number.isFinite(value.width) && Number.isFinite(value.height)
    && value.width >= 1400 && value.width <= 1500 && value.height >= 720 && value.height <= 920;
}
export function installHomeScale() {
  let baseline;
  try { baseline = JSON.parse(localStorage.getItem(BASELINE_KEY)); } catch {}
  if (!validBaseline(baseline)) {
    // Calibrate only on the reference laptop at its measured 175% OS scaling,
    // with a full-width browser at 100%. Other screens use the safe fallback.
    const reference = Math.abs(screen.width * 1.75 - 2560) < 8
      && Math.abs(screen.height * 1.75 - 1600) < 8
      && Math.abs(devicePixelRatio - 1.75) < .02
      && innerWidth >= screen.availWidth - 40;
    baseline = reference ? { width: innerWidth, height: Math.max(720, innerHeight) } : DEFAULT_BASELINE;
    if (!validBaseline(baseline)) baseline = DEFAULT_BASELINE;
    if (reference) { try { localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline)); } catch {} }
  }
  const root = document.documentElement;
  root.style.setProperty('--home-design-width', `${baseline.width}px`);
  root.style.setProperty('--home-design-height', `${baseline.height}px`);
  root.style.setProperty('--home-design-padding', `${baseline.width * .015}px`);
  root.style.setProperty('--home-panel-padding', `${baseline.width * .0125}px`);
  function resize() {
    const scale = fitHomeCanvas(innerWidth, innerHeight, baseline);
    root.style.setProperty('--home-canvas-scale', String(scale));
    root.dataset.homeScale = String(scale);
  }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('pageshow', resize);
}
if (typeof document !== 'undefined') installHomeScale();
