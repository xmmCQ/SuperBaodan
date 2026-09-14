export const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
export function button(text, action, className = '') { const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', action); return el; }
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
