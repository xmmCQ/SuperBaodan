export const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
const actionIcons = {
  '添加文档': 'file-plus', '导入 Markdown': 'upload', '关闭': 'x', '＋ 添加分类': 'folder-plus',
  '编辑': 'pencil', '删除': 'trash-2', '浏览本地文件': 'folder-open', '重新读取目录版本': 'refresh-cw',
  '重命名': 'pencil', '删除分类': 'trash-2',
};
const customPaths = {
  'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M12 12v6M9 15h6"/>',
  'folder-plus': '<path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2ZM12 10v6M9 13h6"/>',
  'folder-open': '<path d="M3 20h16l3-12H9L7 6H2v12a2 2 0 0 0 2 2M2 6V4h6l2 2h9v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
};
export function decorateDocumentAction(el, icon, label, withText = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  if (customPaths[icon]) svg.innerHTML = customPaths[icon];
  else {
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/icons.svg?v=6#${icon}`); svg.append(use);
  }
  el.replaceChildren(svg);
  if (withText) el.append(document.createTextNode(label));
  el.classList.add(withText ? 'wd-icon-label' : 'wd-icon-button');
  if (icon === 'trash-2') el.classList.add('wd-danger-action');
  el.title = label; el.setAttribute('aria-label', label);
  return el;
}
export function button(text, action, className = '') {
  const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', action);
  if (actionIcons[text]) decorateDocumentAction(el, actionIcons[text], text.replace(/^＋ /, ''), ['重命名', '删除分类'].includes(text));
  return el;
}
export function field(container, label, value = '', options = {}) {
  const wrap = node('label', label), input = node(options.choices ? 'select' : 'input');
  if (options.choices) for (const [id, name] of options.choices) input.append(new Option(name, id));
  else { input.type = 'text'; input.maxLength = options.max || 2048; }
  input.value = value; input.setAttribute('aria-label', label); wrap.append(input); container.append(wrap); return input;
}
export function documentDialog({ title, uiDialogs, build, save, reload, wide = false, hasInitialDraft = false, saveLabel = '保存', actionsAtTop = false }) {
  const dialog = node('dialog', '', `modal wd-editor${wide ? ' wd-import' : ''}`), form = node('form');
  const heading = node('div', '', 'modal-heading'), titleNode = node('h3', title); titleNode.id = `wd-title-${crypto.randomUUID()}`;
  dialog.setAttribute('aria-labelledby', titleNode.id);
  let busy = false, closing = false;
  const close = button('关闭', cancel), body = node('fieldset'), notice = node('p', '', 'wd-notice'); notice.setAttribute('role', 'status');
  const footer = node('div', '', 'wd-footer'), submit = node('button', saveLabel, 'wd-primary'); submit.type = 'submit';
  const refresh = button('重新读取目录版本', async () => {
    if (busy) return; setBusy(true);
    try { await reload(); notice.textContent = '已读取最新目录；草稿保留，保存将应用到最新目录。'; refresh.hidden = true; }
    catch (error) { notice.textContent = error.message; }
    finally { setBusy(false); }
  }); refresh.hidden = true;
  const content = node('div', '', 'wd-editor-fields'); body.append(content);
  const collect = build(content), original = JSON.stringify(collect());
  function dirty() { return hasInitialDraft || JSON.stringify(collect()) !== original; }
  function setBusy(value) { busy = value; body.disabled = value; submit.disabled = value; close.disabled = value; refresh.disabled = value; }
  function dispose() { dialog.close(); dialog.remove(); window.removeEventListener('beforeunload', beforeUnload); }
  async function cancel() {
    if (busy || closing) return; closing = true;
    try { if (!dirty() || await uiDialogs.confirm('尚未保存，确定放弃当前草稿吗？', { title: '放弃修改', confirmText: '放弃' })) dispose(); }
    finally { closing = false; }
  }
  function beforeUnload(event) { if (dirty() || busy) { event.preventDefault(); event.returnValue = ''; } }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try { await save(collect()); dispose(); }
    catch (error) { notice.textContent = error.message; refresh.hidden = (error.status || error.statusCode) !== 409; }
    finally { setBusy(false); }
  });
  footer.append(refresh, button('取消', cancel), submit); heading.append(titleNode, close);
  if (actionsAtTop) {
    dialog.classList.add('wd-actions-top');
    form.append(heading, footer, notice, body);
  } else form.append(heading, body, notice, footer);
  dialog.append(form); document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
  window.addEventListener('beforeunload', beforeUnload); dialog.showModal(); content.querySelector('input,select')?.focus();
  return dialog;
}
