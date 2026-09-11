import { IMAGE_TYPES, IMAGE_LIMIT_HINT, validateImageSizes, validatePromptImages, imageBytes } from '../core/prompt-images.js';
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error || new Error('图片读取失败')); reader.onabort = () => reject(new Error('图片读取已取消')); reader.readAsDataURL(file); });
}
export function createImageAttachments({ state, input, container, getScope, showError }) {
  let epoch = 0, reading = 0, tail = Promise.resolve();
  input.accept = IMAGE_TYPES.join(','); input.title = IMAGE_LIMIT_HINT;
  const hint = document.createElement('span'); hint.className = 'attachment-limits'; hint.textContent = IMAGE_LIMIT_HINT;
  function render() {
    container.replaceChildren(); container.classList.toggle('hidden', !state.images.length);
    state.images.forEach(image => {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'attachment-chip'; chip.textContent = `${image.name} ×`;
      chip.addEventListener('click', () => { state.images = state.images.filter(item => item !== image); render(); }); container.append(chip);
    });
    if (state.images.length) container.append(hint);
  }
  function clear() { epoch++; state.images = []; render(); }
  function take() { const items = state.images.slice(), scope = getScope(); clear(); return { items, scope, epoch }; }
  function restore(ticket) {
    if (!ticket || ticket.scope !== getScope() || ticket.epoch !== epoch) return false;
    state.images = [...ticket.items.filter(item => !state.images.includes(item)), ...state.images];
    render(); return true;
  }
  function add() {
    const files = [...input.files], scope = getScope(), generation = epoch; input.value = ''; reading++;
    const operation = tail.then(async () => {
      if (scope !== getScope() || generation !== epoch) return;
      const metadata = state.images.map(item => ({ mimeType: item.mimeType, size: imageBytes(item) }));
      validateImageSizes([...metadata, ...files.map(file => ({ mimeType: file.type, size: file.size }))]);
      const added = [];
      for (const file of files) { const dataUrl = await readFileAsDataUrl(file); added.push({ name: file.name, mimeType: file.type, data: dataUrl.split(',', 2)[1] }); }
      if (scope !== getScope() || generation !== epoch) return;
      validatePromptImages([...state.images, ...added]); state.images.push(...added); render();
    }).catch(error => { if (scope === getScope() && generation === epoch) showError(error); }).finally(() => { reading--; });
    tail = operation; return operation;
  }
  return { add, render, clear, take, restore, isReading: () => reading > 0 };
}
