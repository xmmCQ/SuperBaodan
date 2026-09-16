import { validateDocuments, normalizeTarget, UNCATEGORIZED, targetKey } from '../core/work-documents.js';
import { parseDocumentMarkdown, checkImportRow, mergeDocumentImport } from '../core/work-document-import.js';
import { node, button, field, documentDialog, decorateDocumentAction } from './work-document-dialog.js';
import { createDocumentSorter, documentDragHandle, reorderDocumentSlots } from './work-document-sort.js';

function documentKind(target) {
  return /^https?:\/\//i.test(target.trim().replace(/^"(.*)"$/s, '$1')) ? 'url' : 'file';
}

export function createWorkDocuments({ trigger, api, uiDialogs }) {
  const dialog = node('dialog', '', 'modal wd-dialog'); dialog.id = 'workDocumentsDialog'; dialog.setAttribute('aria-labelledby', 'workDocumentsTitle');
  const heading = node('div', '', 'modal-heading'), title = node('h3', '工作文档'); title.id = 'workDocumentsTitle';
  const toolbar = node('div', '', 'wd-toolbar'), search = node('input'); search.type = 'search'; search.placeholder = '搜索名称、分类或地址'; search.setAttribute('aria-label', search.placeholder); search.maxLength = 100;
  const notice = node('p', '', 'wd-notice'); notice.setAttribute('role', 'status');
  const layout = node('div', '', 'wd-layout'), categories = node('nav', '', 'wd-categories'), list = node('div', '', 'wd-list'); categories.setAttribute('aria-label', '文档分类');
  const input = node('input'); input.type = 'file'; input.accept = '.md,text/markdown'; input.hidden = true;
  const add = button('添加文档', () => editDocument(), 'wd-primary'), importButton = button('导入 Markdown', () => input.click());
  const template = node('a', '下载模板', 'wd-download-template'); template.href = '/templates/work-documents.md'; template.download = '工作文档导入模板.md'; decorateDocumentAction(template, 'download', '下载模板');
  heading.append(title, button('关闭', () => dialog.close())); toolbar.append(search, add, importButton, template);
  const deleteOption = node('label', '', 'wd-delete-option');
  const recycleSource = node('input'); recycleSource.type = 'checkbox';
  deleteOption.append(recycleSource, node('span', '删除入口时同时将源文件移入回收站'));
  layout.append(categories, list); dialog.append(heading, toolbar, notice, layout, deleteOption, input); document.body.append(dialog);
  let data = null, selected = 'all', busy = false, loading = 0, confirmingRecycle = false, recycleEnabled = false;
  recycleSource.addEventListener('change', async () => {
    if (!recycleSource.checked) { recycleEnabled = false; controls(); return; }
    recycleSource.checked = false; confirmingRecycle = true; controls();
    try {
      const accepted = await uiDialogs.confirm('勾选后删除快捷目录同时会删除源文件，是否确认勾选？', { title: '确认启用源文件删除', confirmText: '确认勾选', danger: true, compact: true, emphasisText: '删除源文件' });
      recycleEnabled = Boolean(accepted && dialog.open);
      recycleSource.checked = recycleEnabled;
    } finally { confirmingRecycle = false; controls(); }
  });
  const pending = new Set();
  const say = message => { notice.textContent = message; };
  const clone = () => structuredClone(validateDocuments(data));
  function removalLabels() {
    for (const el of list.querySelectorAll('[data-remove-document]')) {
      const doc = data?.documents.find(item => item.id === el.dataset.removeDocument);
      const label = recycleEnabled && doc?.kind === 'file' ? '删除入口并将源文件移入回收站' : '删除文档入口（保留源文件）';
      el.title = label; el.setAttribute('aria-label', label);
    }
  }
  function controls() { add.disabled = importButton.disabled = busy || !data; recycleSource.disabled = busy || confirmingRecycle; removalLabels(); }
  async function load(throwOnError = false) {
    const sequence = ++loading; busy = true; controls();
    try {
      const next = await api('/api/work-documents'); validateDocuments(next);
      if (sequence !== loading) return;
      data = next; say(''); render();
    } catch (error) { say(`读取失败：${error.message}`); if (throwOnError) throw error; }
    finally { if (sequence === loading) { busy = false; controls(); render(); } }
  }
  const sortEnabled = () => Boolean(data && !busy && !confirmingRecycle && !search.value.trim() && dialog.open);
  const sortContext = () => `${selected}|${search.value}|${data?.revision}`;
  async function saveOrder(kind, from, to, after) {
    if (!sortEnabled()) return;
    const next = clone();
    const populated = new Set(data.documents.map(doc => doc.categoryId));
    const predicate = kind === 'categories'
      ? category => category.id !== UNCATEGORIZED && populated.has(category.id)
      : doc => selected === 'all' || doc.categoryId === selected;
    if (!reorderDocumentSlots(next[kind], from, to, after, predicate)) return;
    const container = kind === 'categories' ? categories : list;
    const sourceRow = [...container.children].find(row => row.dataset.sortId === from);
    const targetRow = [...container.children].find(row => row.dataset.sortId === to);
    if (!sourceRow || !targetRow) return;
    const originalNext = sourceRow.nextSibling, scrollTop = container.scrollTop;
    const revision = data.revision;
    busy = true; controls(); search.readOnly = true;
    try {
      // Let the native drag finish before moving its source node.
      await new Promise(requestAnimationFrame);
      if (after) targetRow.after(sourceRow); else targetRow.before(sourceRow);
      container.scrollTop = scrollTop;
      data = await api('/api/work-documents', { method: 'PUT', body: JSON.stringify({ ...next, revision }) });
      say('');
    } catch (error) {
      if (sourceRow.parentElement === container) {
        container.insertBefore(sourceRow, originalNext?.parentElement === container ? originalNext : null);
        container.scrollTop = scrollTop;
      }
      if ((error.status || error.statusCode) === 409) {
        await load(); say('目录已被其他页面修改，已重新读取，请重新排序');
      } else say(`排序保存失败：${error.message}`);
    } finally {
      busy = false; controls(); search.readOnly = false;
    }
  }
  const categorySorter = createDocumentSorter({ container: categories, enabled: sortEnabled, context: sortContext, onMove: (...args) => saveOrder('categories', ...args) });
  const documentSorter = createDocumentSorter({ container: list, enabled: sortEnabled, context: sortContext, onMove: (...args) => saveOrder('documents', ...args) });
  async function commit(next, silent = false) {
    const validated = validateDocuments(next);
    busy = true; controls();
    try { data = await api('/api/work-documents', { method: 'PUT', body: JSON.stringify({ ...validated, revision: data.revision }) }); say(silent ? '' : '已保存'); }
    finally { busy = false; controls(); render(); }
  }
  async function mutate(operation) {
    if (busy || !data) return;
    try { const next = clone(); operation(next); await commit(next); }
    catch (error) { say(error.message); }
  }
  function action(text, label, callback) { const el = button(text, callback, 'wd-small'); el.title = label; el.setAttribute('aria-label', label); el.disabled = busy; return el; }
  function render() {
    categorySorter.cancel(); documentSorter.cancel();
    const categoryScroll = categories.scrollTop, documentScroll = list.scrollTop;
    categories.replaceChildren(); list.replaceChildren();
    if (!data) { list.append(node('p', '打开目录后可添加文档或导入 Markdown。', 'form-hint')); return; }
    const counts = new Map();
    for (const doc of data.documents) counts.set(doc.categoryId, (counts.get(doc.categoryId) || 0) + 1);
    const visibleCategories = [
      ...data.categories.filter(c => c.id !== UNCATEGORIZED),
      ...data.categories.filter(c => c.id === UNCATEGORIZED),
    ].filter(c => counts.get(c.id) > 0);
    if (selected !== 'all' && !visibleCategories.some(c => c.id === selected)) selected = 'all';
    for (const category of [{ id: 'all', name: '全部' }, ...visibleCategories]) {
      const row = node('div', '', 'wd-category');
      const count = category.id === 'all' ? data.documents.length : counts.get(category.id);
      const choose = button(`${category.name} · ${count}`, () => { if (busy) return; selected = category.id; search.value = ''; list.scrollTop = 0; render(); }, category.id === selected ? 'active' : ''); choose.disabled = busy;
      if (![UNCATEGORIZED, 'all'].includes(category.id)) {
        row.dataset.sortId = category.id;
        const handle = documentDragHandle('拖动调整分类顺序'); handle.disabled = !sortEnabled(); row.append(handle);
      }
      row.append(choose);
      if (category.id === 'all') {
        const newCategory = button('＋ 添加分类', () => editCategory()); newCategory.disabled = busy; row.append(newCategory);
      }
      if (![UNCATEGORIZED, 'all'].includes(category.id)) {
        const menu = node('details', '', 'wd-category-menu'), summary = node('summary', '⋯'); summary.setAttribute('aria-label', `${category.name}分类操作`);
        const options = node('div'); options.append(button('重命名', () => !busy && editCategory(category)), button('删除分类', () => void deleteCategory(category)));
        menu.append(summary, options); row.append(menu);
      }
      categories.append(row);
    }
    const query = search.value.trim().toLowerCase(), categoryNames = new Map(data.categories.map(c => [c.id, c.name]));
    const visible = data.documents.filter(d => query ? `${d.name} ${categoryNames.get(d.categoryId)} ${d.target}`.toLowerCase().includes(query) : selected === 'all' || d.categoryId === selected);
    if (!visible.length) list.append(node('p', query ? '没有匹配的文档' : '暂无文档，点击“添加文档”或“导入 Markdown”。', 'form-hint'));
    for (const doc of visible) {
      const row = node('article', '', 'wd-row'); row.dataset.id = doc.id; row.dataset.sortId = doc.id;
      const handle = documentDragHandle(search.value.trim() ? '搜索时不可排序' : '拖动调整文档顺序'); handle.disabled = !sortEnabled();
      const info = node('div', '', 'wd-doc-info'), type = doc.kind === 'url' ? '网页' : doc.target.split('.').at(-1).toUpperCase();
      const link = node(doc.kind === 'url' ? 'a' : 'button', doc.name, 'wd-doc-name');
      if (doc.kind === 'url') { link.href = normalizeTarget('url', doc.target); link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else { link.type = 'button'; link.disabled = busy || pending.has(doc.id); }
      link.addEventListener('click', event => {
        if (busy || pending.has(doc.id)) { event.preventDefault(); return; }
        pending.add(doc.id);
        if (doc.kind === 'url') { setTimeout(() => pending.delete(doc.id), 800); return; }
        link.disabled = true;
        void api('/api/work-documents/open', { method: 'POST', body: JSON.stringify({ id: doc.id, revision: data.revision }) })
          .then(result => say(result.message || '已交给系统打开')).catch(error => say(`${doc.name}：${error.message}`))
          .finally(() => setTimeout(() => { pending.delete(doc.id); if (link.isConnected) link.disabled = busy; }, 800));
      });
      const address = node('small', `${categoryNames.get(doc.categoryId)} · ${doc.target}`); address.title = doc.target;
      info.append(link, address);
      const actions = node('div', '', 'wd-row-actions');
      const remove = action('删除', '删除文档入口', () => void deleteDocument(doc)); remove.dataset.removeDocument = doc.id;
      actions.append(action('编辑', '编辑文档入口', () => editDocument(doc)), remove);
      row.append(handle, node('span', type, 'wd-type'), info, actions); list.append(row);
    }
    removalLabels();
    categories.scrollTop = categoryScroll; list.scrollTop = documentScroll;
  }
  function editCategory(category) {
    if (busy || !data) return;
    documentDialog({ title: category ? '重命名分类' : '添加分类', uiDialogs, reload: () => load(true),
      build: content => { const name = field(content, '分类名称', category?.name || '', { max: 40 }); return () => name.value; },
      save: async name => {
        const next = clone();
        if (category) { const found = next.categories.find(c => c.id === category.id); if (!found) throw new Error('分类已删除，请关闭后重新添加'); found.name = name; }
        else next.categories.push({ id: crypto.randomUUID(), name });
        await commit(next);
      } });
  }
  function editDocument(doc) {
    if (busy || !data) return;
    documentDialog({ title: doc ? '编辑文档入口' : '添加文档', uiDialogs, reload: () => load(true),
      build: content => {
        const name = field(content, '文档名称', doc?.name || '', { max: 100 });
        const category = field(content, '分类', doc?.categoryId || (selected === 'all' ? UNCATEGORIZED : selected), { choices: data.categories.map(c => [c.id, c.name]) });
        const target = field(content, '文件路径或网址', doc?.target || '');
        let picking = false;
        const pickerStatus = node('p', '', 'wd-picker-status'); pickerStatus.setAttribute('role', 'status');
        const browse = button('浏览本地文件', async () => {
          if (picking) return;
          picking = true; browse.disabled = true; target.disabled = true;
          browse.title = '正在选择…'; browse.setAttribute('aria-label', '正在选择本地文件'); pickerStatus.textContent = '请在 Windows 文件选择窗口中选择文档。';
          const editor = content.closest('dialog'), controller = new AbortController();
          const cancelPick = () => controller.abort(); editor.addEventListener('close', cancelPick, { once: true });
          try {
            const result = await api('/api/work-documents/pick-file', { method: 'POST', body: '{}', signal: controller.signal, timeout: 185000 });
            if (!editor.isConnected || !editor.open) return;
            if (!result.cancelled) { target.value = result.path; if (!name.value.trim()) name.value = result.name.slice(0, 100); }
            pickerStatus.textContent = result.cancelled ? '已取消选择，原内容保持不变。' : '已选择文件，名称可自定义；点击保存创建入口。';
          } catch (error) { if (editor.isConnected) pickerStatus.textContent = error.message; }
          finally { editor.removeEventListener('close', cancelPick); picking = false; browse.disabled = false; target.disabled = false; browse.title = '浏览本地文件'; browse.setAttribute('aria-label', '浏览本地文件'); }
        }, 'wd-browse-file');
        target.addEventListener('input', () => { pickerStatus.textContent = ''; });
        content.append(browse, pickerStatus);
        target.addEventListener('change', () => { if (!name.value.trim() && documentKind(target.value) === 'file') name.value = target.value.trim().replace(/^"|"$/g, '').split(/[\\/]/).at(-1).slice(0, 100); });
        return () => ({ id: doc?.id || 'new', name: name.value, categoryId: category.value, kind: documentKind(target.value), target: target.value, picking });
      },
      save: async values => {
        if (values.picking) throw new Error('请先完成或取消文件选择，再保存入口');
        delete values.picking;
        const next = clone();
        if (doc) { const index = next.documents.findIndex(d => d.id === doc.id); if (index < 0) throw new Error('该入口已删除，请关闭后重新添加'); next.documents[index] = values; }
        else next.documents.push({ ...values, id: crypto.randomUUID() });
        await commit(next);
      } });
  }
  async function deleteDocument(doc) {
    if (busy || confirmingRecycle || !data) return;
    busy = true; controls(); render();
    try {
      const result = await api('/api/work-documents/remove', { method: 'POST', body: JSON.stringify({ id: doc.id, revision: data.revision, recycleSource: recycleEnabled }) });
      data = result; say(result.recycled ? (result.message || '源文件已移入回收站') : '');
    } catch (error) { say(error.message); }
    finally { busy = false; controls(); render(); }
  }
  async function deleteCategory(category) {
    if (busy || !await uiDialogs.confirm(`删除「${category.name}」分类，文档入口将移入“未分类”，原文件不受影响。`, { title: '删除分类', confirmText: '删除分类' })) return;
    await mutate(n => {
      for (const doc of n.documents) if (doc.categoryId === category.id) doc.categoryId = UNCATEGORIZED;
      if (new Set(n.documents.map(targetKey)).size !== n.documents.length) throw new Error('未分类中已有同一文档入口；请先处理重复入口，再删除分类。当前目录未修改。');
      n.categories = n.categories.filter(c => c.id !== category.id);
    });
  }
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; input.value = ''; if (!file || busy || !data) return;
    busy = true; controls(); render();
    try {
      if (!/\.md$/i.test(file.name) || file.size > 1024 * 1024) throw new Error('请选择不超过1 MiB的 UTF-8 Markdown 文件');
      const rows = parseDocumentMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      if (!dialog.open) return;
      if (!rows.length) { say('没有找到可导入的 Markdown 链接'); return; }
      openImport(rows);
    } catch (error) { say(`导入失败：${error.message}`); }
    finally { busy = false; controls(); render(); }
  });
  function openImport(rows) {
    documentDialog({ title: '导入预览', uiDialogs, wide: true, actionsAtTop: true, hasInitialDraft: true, saveLabel: '确认导入', reload: () => load(true),
      build: content => {
        content.append(node('p', '只导入选中的标题和链接，不修改原 Markdown。无效条目可修正后勾选。', 'form-hint'));
        const status = node('p', '', 'wd-import-summary'), editors = [];
        const collect = () => editors.map(e => ({ selected: e.selected.checked, name: e.name.value, category: e.category.value, kind: documentKind(e.target.value), target: e.target.value }));
        function assess() {
          const values = collect(); let invalid = 0;
          values.forEach((row, i) => {
            editors[i].box.classList.toggle('is-excluded', !row.selected);
            editors[i].excluded.classList.toggle('hidden', row.selected);
            try { checkImportRow(row); editors[i].error.textContent = ''; } catch (error) { invalid++; editors[i].error.textContent = error.message; }
          });
          try { const merged = mergeDocumentImport(data, values); status.textContent = `将新增 ${merged.added} 项，重复 ${merged.duplicates} 项，无效 ${invalid} 项`; }
          catch (error) { status.textContent = error.message; }
        }
        content.append(status);
        for (const row of rows) {
          const box = node('div', '', 'wd-import-row'), selected = node('input'); selected.type = 'checkbox'; selected.checked = row.selected; selected.setAttribute('aria-label', '导入此条目');
          const meta = node('div', '', 'wd-import-meta');
          const excluded = node('span', '不导入', 'wd-import-excluded hidden');
          meta.append(node('span', `第${row.line}行`, 'form-hint'), excluded);
          box.append(selected, meta);
          const name = field(box, '名称', row.name, { max: 100 }), category = field(box, '分类', row.category, { max: 40 });
          const target = field(box, '地址', row.target);
          const error = node('small', row.error || '', 'wd-import-error'); box.append(error); content.append(box);
          editors.push({ box, excluded, selected, name, category, target, error }); box.addEventListener('input', assess);
        }
        assess(); return collect;
      },
      save: async rows => {
        const merged = mergeDocumentImport(data, rows);
        if (merged.added) await commit(merged.data);
        say(`导入完成：新增 ${merged.added} 项，跳过重复 ${merged.duplicates} 项，无效 ${merged.invalid} 项`);
      } });
  }
  search.addEventListener('input', render);
  trigger.addEventListener('click', () => { if (dialog.open || busy) return; recycleEnabled = false; recycleSource.checked = false; dialog.showModal(); render(); void load(); });
  dialog.addEventListener('close', () => { categorySorter.cancel(); documentSorter.cancel(); recycleEnabled = false; recycleSource.checked = false; trigger.focus(); });
  return { load, render };
}
