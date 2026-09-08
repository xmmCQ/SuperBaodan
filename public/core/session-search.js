export function searchStatus(result) {
  if (!result.complete) return `结果未完整扫描（已找到 ${result.hits.length} 条），请缩小关键词后重试`;
  return result.hits.length ? `找到 ${result.hits.length} 条匹配消息` : "未找到匹配的用户或助手文本";
}

export function createSessionSearch({ input, results, defaultList, search, onOpen, getWorkspaceId = () => null, debounceMs = 250 }) {
  let timer, controller, sequence = 0;
  function cancel() { clearTimeout(timer); controller?.abort(); controller = null; sequence += 1; }
  function showStatus(text) {
    const node = document.createElement("p");
    node.className = "session-search-status"; node.setAttribute("role", "status"); node.textContent = text;
    results.replaceChildren(node);
  }
  function refresh() {
    cancel();
    const query = input.value.trim();
    defaultList.classList.toggle("hidden", Boolean(query)); results.classList.toggle("hidden", !query);
    if (!query) { results.replaceChildren(); return; }
    const current = sequence, workspaceId = getWorkspaceId();
    controller = new AbortController();
    const signal = controller.signal;
    showStatus("正在搜索当前工作区的用户和助手文本……");
    timer = setTimeout(async () => {
      try {
        const result = await search(query, { signal });
        if (signal.aborted || current !== sequence) return;
        if (workspaceId !== getWorkspaceId()) { refresh(); return; }
        showStatus(searchStatus(result));
        for (const hit of result.hits) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "session-search-hit";
          const title = document.createElement("strong"); title.textContent = hit.title;
          const location = document.createElement("small");
          const date = hit.timestamp ? new Date(hit.timestamp) : null;
          const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "时间未知";
          location.textContent = `${hit.role === "user" ? "用户" : "助手"} · ${time} · ${hit.messageIndex == null ? `记录第${hit.lineNumber}行` : `第${hit.messageIndex + 1}条消息`}`;
          const snippet = document.createElement("span"); snippet.textContent = hit.snippet;
          button.append(title, location, snippet);
          button.addEventListener("click", async () => {
            if (workspaceId !== getWorkspaceId()) { refresh(); return; }
            button.disabled = true;
            try { await onOpen(hit); }
            catch (error) { if (current === sequence) showStatus(error.message || "无法打开会话"); }
            finally { button.disabled = false; }
          });
          results.append(button);
        }
      } catch (error) {
        if (!signal.aborted && current === sequence) showStatus(`搜索未完成：${error.message || "连接失败"}，请重试`);
      }
    }, debounceMs);
  }
  input.addEventListener("input", refresh);
  return { refresh, cancel, reset() { input.value = ""; refresh(); } };
}
