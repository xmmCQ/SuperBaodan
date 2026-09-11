export function createWorkApps({ trigger, api, uiDialogs, toast, escapeHtml: esc, openAll }) {
  const wrapper = document.createElement('div'); wrapper.className = 'work-app-launcher';
  trigger.before(wrapper); wrapper.append(trigger);
  const menu = document.createElement('div'); menu.id = 'workAppsMenu'; menu.className = 'work-app-menu hidden';
  menu.innerHTML = '<button type="button" data-open-all>打开全部</button><button type="button" data-manage-apps>管理软件</button>';
  wrapper.append(menu); trigger.setAttribute('aria-haspopup', 'true'); trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
  const dialog = document.createElement('dialog'); dialog.className = 'modal work-app-dialog'; dialog.id = 'workAppsDialog'; dialog.setAttribute('aria-labelledby', 'workAppsTitle');
  dialog.innerHTML = `<form>
    <div class="modal-heading"><h3 id="workAppsTitle">管理工作软件</h3><button class="icon-action" type="button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="/icons.svg#x"></use></svg></button></div>
    <p class="form-hint">配置本机程序或快捷方式。勾选的软件按列表顺序一键打开。</p>
    <fieldset><div class="work-app-list"></div>
      <button type="button" class="work-app-button work-app-add" data-add>＋ 添加软件</button>
      <p class="work-app-notice" role="status"></p>
      <div class="modal-actions"><button class="work-app-button" type="button" data-cancel>取消</button><button class="work-app-button work-app-save" type="submit">保存配置</button></div>
    </fieldset></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), list = dialog.querySelector('.work-app-list'), fields = dialog.querySelector('fieldset'), notice = dialog.querySelector('.work-app-notice');
  let apps = [], revision = '', original = '', busy = false, closing = false;
  function collect() {
    for (const row of list.children) {
      const app = apps.find(a => a.id === row.dataset.id); if (!app) continue;
      app.name = row.querySelector('[data-name]').value; app.path = row.querySelector('[data-path]').value; app.enabled = row.querySelector('[data-enabled]').checked;
    }
  }
  const dirty = () => { collect(); return JSON.stringify(apps) !== original; };
  function menuClose() { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); }
  function setBusy(value) { busy = value; fields.disabled = value; dialog.querySelector('[data-close]').disabled = value; }
  function render() {
    const scroll = list.scrollTop;
    list.innerHTML = apps.map((app, index) => `<article class="work-app-row" data-id="${esc(app.id)}">
      <div class="work-app-row-head"><input data-name required maxlength="40" value="${esc(app.name)}" aria-label="软件名称" placeholder="软件名称">
        <button type="button" class="icon-action" data-up ${index === 0 ? 'disabled' : ''} aria-label="上移"><svg aria-hidden="true"><use href="/icons.svg#arrow-up"></use></svg></button>
        <button type="button" class="icon-action work-app-down" data-down ${index === apps.length - 1 ? 'disabled' : ''} aria-label="下移"><svg aria-hidden="true"><use href="/icons.svg#arrow-up"></use></svg></button>
        <button type="button" class="icon-action" data-delete aria-label="删除软件"><svg aria-hidden="true"><use href="/icons.svg#trash-2"></use></svg></button></div>
      <input data-path required maxlength="514" value="${esc(app.path)}" aria-label="程序或快捷方式完整路径" placeholder="粘贴 .exe 或 .lnk 完整路径">
      <div class="work-app-row-foot"><label><input type="checkbox" data-enabled ${app.enabled ? 'checked' : ''}>参与一键打开</label><button type="button" class="work-app-button" data-run>启动</button></div>
    </article>`).join('') || '<p class="form-hint">尚未配置软件，点击下方添加。</p>';
    list.scrollTop = scroll; dialog.querySelector('[data-add]').disabled = apps.length >= 20;
  }
  async function open() {
    menuClose(); if (busy) return;
    busy = true;
    try {
      const data = await api('/api/apps/config'); apps = data.apps; revision = data.revision; original = JSON.stringify(apps);
      notice.textContent = ''; render(); dialog.showModal();
    } catch (error) { toast(`读取软件配置失败：${error.message}`, true); }
    finally { setBusy(false); }
  }
  async function close() {
    if (busy || closing) return;
    closing = true;
    try { if (!dirty() || await uiDialogs.confirm('修改尚未保存，确定放弃吗？', { title: '放弃修改', confirmText: '放弃' })) { dialog.close(); trigger.focus(); } }
    finally { closing = false; }
  }
  trigger.addEventListener('click', () => { if (busy) return; const show = menu.classList.contains('hidden'); menu.classList.toggle('hidden', !show); trigger.setAttribute('aria-expanded', String(show)); if (show) menu.firstElementChild.focus(); });
  menu.querySelector('[data-open-all]').addEventListener('click', () => { menuClose(); void openAll(); });
  menu.querySelector('[data-manage-apps]').addEventListener('click', open);
  document.addEventListener('click', event => { if (!wrapper.contains(event.target)) menuClose(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.classList.contains('hidden')) { event.preventDefault(); event.stopImmediatePropagation(); menuClose(); trigger.focus(); } }, true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  dialog.querySelector('[data-close]').addEventListener('click', close); dialog.querySelector('[data-cancel]').addEventListener('click', close);
  dialog.querySelector('[data-add]').addEventListener('click', () => {
    if (busy || apps.length >= 20) return; collect(); apps.push({ id: crypto.randomUUID(), name: '', path: '', enabled: true, processes: [] }); render(); list.lastElementChild.querySelector('[data-name]').focus();
  });
  list.addEventListener('click', async event => {
    const button = event.target.closest('button'), row = button?.closest('[data-id]'); if (!row || busy) return;
    collect(); const index = apps.findIndex(a => a.id === row.dataset.id);
    if (button.hasAttribute('data-run')) {
      if (dirty()) { notice.textContent = '请先保存配置，再启动软件'; return; }
      setBusy(true); notice.textContent = '正在发送启动请求…';
      try { const data = await api('/api/apps/open', { method: 'POST', body: JSON.stringify({ id: apps[index].id, revision }) }); notice.textContent = [...data.results.map(r => `${r.name}：${r.message}`), data.warning].filter(Boolean).join('；'); }
      catch (error) { notice.textContent = error.message; }
      finally { setBusy(false); }
      return;
    }
    if (button.hasAttribute('data-delete')) apps.splice(index, 1);
    else { const next = index + (button.hasAttribute('data-up') ? -1 : 1); if (next < 0 || next >= apps.length) return; [apps[index], apps[next]] = [apps[next], apps[index]]; }
    render();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; collect(); setBusy(true); notice.textContent = '正在保存…';
    try {
      const data = await api('/api/apps/config', { method: 'PUT', body: JSON.stringify({ revision, apps }) });
      apps = data.apps; revision = data.revision; original = JSON.stringify(apps); render(); notice.textContent = '配置已保存';
    } catch (error) { notice.textContent = error.message; }
    finally { setBusy(false); }
  });
}
