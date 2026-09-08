import { preserveReadingPositions } from "./reading-position.js";

export const READING_STORAGE_KEY = "super-baodan.reading.v1";
export const DEFAULT_READING = Object.freeze({ size: "standard", width: "standard" });
export function normalizeReading(value) {
  return {
    size: ["small", "standard", "large"].includes(value?.size) ? value.size : "standard",
    width: ["standard", "wide"].includes(value?.width) ? value.width : "standard",
  };
}

// The home page only applies shared preferences. Controls live in Settings.
export function createReadingSettings({ mount, container, onNotice = () => {} }) {
  function stored() {
    try { return normalizeReading(JSON.parse(localStorage.getItem(READING_STORAGE_KEY))); }
    catch { return { ...DEFAULT_READING }; }
  }
  let preference = stored(), controls, size, width;
  if (mount) {
    controls = document.createElement("section");
    controls.className = "reading-settings-inline";
    controls.setAttribute("aria-labelledby", "readingSettingsTitle");
    controls.innerHTML = `<header><strong id="readingSettingsTitle">阅读设置</strong></header>
      <label>字号<select name="size" aria-label="聊天字号"><option value="small">小</option><option value="standard">标准</option><option value="large">大</option></select></label>
      <label>正文宽度<select name="width" aria-label="聊天正文宽度"><option value="standard">标准</option><option value="wide">宽版</option></select></label>
      <p>立即生效，首页和展开助手共用；只调整聊天正文。</p>
      <button class="reading-reset" type="button">恢复默认设置</button>`;
    mount.append(controls);
    size = controls.querySelector('[name="size"]'); width = controls.querySelector('[name="width"]');
    size.addEventListener("change", () => apply({ ...preference, size: size.value }, true));
    width.addEventListener("change", () => apply({ ...preference, width: width.value }, true));
    controls.querySelector(".reading-reset").addEventListener("click", () => apply(DEFAULT_READING, true));
  }
  function apply(next, save = false) {
    preference = normalizeReading(next);
    preserveReadingPositions([container], () => {
      container.dataset.readingSize = preference.size;
      container.dataset.readingWidth = preference.width;
      if (size) size.value = preference.size;
      if (width) width.value = preference.width;
    });
    if (save) {
      try { localStorage.setItem(READING_STORAGE_KEY, JSON.stringify(preference)); }
      catch { onNotice("阅读设置已生效，但浏览器未允许保存偏好", true); }
    }
  }
  const onStorage = (event) => { if (event.key === READING_STORAGE_KEY || event.key === null) apply(stored()); };
  window.addEventListener("storage", onStorage);
  apply(preference);
  return { apply: (value) => apply(value, true), dispose() { window.removeEventListener("storage", onStorage); controls?.remove(); } };
}
