export function createProjectPrompt({ mount, api, getWorkspace, uiDialogs }) {
  mount.innerHTML = `<div class="project-prompt-head"><h3>项目提示词</h3><button type="button" class="project-prompt-reload">重新读取</button></div>
    <p class="project-prompt-context"></p><p class="project-prompt-path"></p>
    <p class="project-prompt-hint">编辑当前项目根目录的 AGENTS.md。保存后立即重载，当前会话的下一次提问会使用新提示词；不清空聊天记录。切换项目请使用页面左上角的项目选择器。</p>
    <textarea class="project-prompt-editor" aria-label="项目提示词内容" spellcheck="false" placeholder="例如：项目背景、语言风格、编码规范、工作约定…" disabled></textarea>
    <div class="project-prompt-actions"><span class="project-prompt-status" role="status"></span><button type="button" class="project-prompt-save" disabled>保存并生效</button></div>`;
  const editor = mount.querySelector('textarea'), reload = mount.querySelector('.project-prompt-reload'), save = mount.querySelector('.project-prompt-save'), status = mount.querySelector('.project-prompt-status');
  let loadedId = null, original = '', revision = null, busy = false, request = 0, confirming = false;
  const hasDraft = () => editor.value !== original;
  function state() { editor.disabled = busy || !revision || loadedId !== getWorkspace()?.id; save.disabled = editor.disabled; reload.disabled = busy; }
  async function canLeave() {
    if (busy) { status.textContent = '正在读取或保存，请稍候'; return false; }
    if (!hasDraft()) return true;
    if (confirming) return false;
    confirming = true;
    try {
      const ok = await uiDialogs.confirm('项目提示词尚未保存，确定放弃修改吗？', { title: '放弃修改', confirmText: '放弃' });
      if (ok) editor.value = original;
      return ok;
    } finally { confirming = false; }
  }
  async function load(force = false) {
    if (busy || (!force && hasDraft())) return;
    if (force && !await canLeave()) return;
    const workspace = getWorkspace(); if (!workspace?.id) { status.textContent = '请先选择项目'; return; }
    const serial = ++request; busy = true; state(); status.textContent = '正在读取…';
    try {
      const data = await api(`/api/workspace/project-prompt?workspaceId=${encodeURIComponent(workspace.id)}`);
      if (serial !== request || workspace.id !== getWorkspace()?.id) { status.textContent = '项目已切换，请重新读取'; return; }
      loadedId = workspace.id; revision = data.revision; original = data.content; editor.value = original;
      mount.querySelector('.project-prompt-context').textContent = `当前项目：${workspace.name}`;
      mount.querySelector('.project-prompt-path').textContent = data.path;
      status.textContent = data.exists ? '已读取项目提示词' : '尚未创建 AGENTS.md，保存后创建';
    } catch (error) { revision = null; status.textContent = error.message; }
    finally { busy = false; state(); }
  }
  save.addEventListener('click', async () => {
    if (busy || !revision || loadedId !== getWorkspace()?.id) return;
    if (new TextEncoder().encode(editor.value).length > 128 * 1024) { status.textContent = '项目提示词不能超过128KB'; return; }
    const content = editor.value, workspaceId = loadedId;
    busy = true; state(); status.textContent = '正在保存并重载项目提示词…';
    try {
      const data = await api('/api/workspace/project-prompt', { method: 'PUT', body: JSON.stringify({ workspaceId, revision, content }) });
      if (workspaceId !== getWorkspace()?.id) { status.textContent = '项目已切换，请重新读取'; return; }
      revision = data.revision; original = data.content; editor.value = original;
      status.textContent = data.applied ? '已保存并生效，下一次提问将使用新提示词' : data.warning || '文件已保存，但重载未成功';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; state(); }
  });
  reload.addEventListener('click', () => void load(true));
  window.addEventListener('beforeunload', event => { if (hasDraft() || busy) { event.preventDefault(); event.returnValue = ''; } });
  return { load, canLeave, hasDraft, discard() { editor.value = original; }, contextChanged() { state(); if (loadedId && loadedId !== getWorkspace()?.id) status.textContent = '项目已切换，请重新读取；旧项目的未保存内容仍保留'; } };
}
