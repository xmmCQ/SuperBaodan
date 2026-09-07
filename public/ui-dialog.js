export function proportionalScrollTop(source, target) {
  const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
  if (!sourceMax || !targetMax) return 0;
  const progress = Math.min(1, Math.max(0, source.scrollTop / sourceMax));
  return progress * targetMax;
}

export function createUiDialogController(elements) {
  const { dialog, form, title, message, field, closeButton, cancelButton, confirmButton } = elements;
  let resolveCurrent = null;
  let inputControl = null;
  let previewFrame = null;
  let scrollSyncFrame = null;
  let scrollUnlockFrame = null;
  let syncingScrollTarget = null;
  let mode = "confirm";

  function cancelPreviewFrame() {
    if (previewFrame == null) return;
    cancelAnimationFrame(previewFrame);
    previewFrame = null;
  }

  function cancelScrollSync() {
    if (scrollSyncFrame != null) cancelAnimationFrame(scrollSyncFrame);
    if (scrollUnlockFrame != null) cancelAnimationFrame(scrollUnlockFrame);
    scrollSyncFrame = null;
    scrollUnlockFrame = null;
    syncingScrollTarget = null;
  }

  function lockScrollTarget(target) {
    if (scrollUnlockFrame != null) cancelAnimationFrame(scrollUnlockFrame);
    scrollUnlockFrame = null;
    syncingScrollTarget = target;
  }

  function queueScrollSync(source, target) {
    if (source === syncingScrollTarget) return;
    if (scrollSyncFrame != null) cancelAnimationFrame(scrollSyncFrame);
    scrollSyncFrame = requestAnimationFrame(() => {
      scrollSyncFrame = null;
      if (!dialog.open || !source.isConnected || !target.isConnected) return;
      lockScrollTarget(target);
      target.scrollTop = proportionalScrollTop(source, target);
      scrollUnlockFrame = requestAnimationFrame(() => {
        scrollUnlockFrame = null;
        syncingScrollTarget = null;
      });
    });
  }

  function settle(value) {
    if (!resolveCurrent) return;
    const resolve = resolveCurrent;
    resolveCurrent = null;
    cancelPreviewFrame();
    cancelScrollSync();
    inputControl = null;
    if (dialog.open) dialog.close();
    resolve(value);
  }

  function open(options = {}) {
    if (resolveCurrent) settle(null);
    mode = options.mode || "confirm";
    const hasPreview = mode === "editor" && typeof options.previewRenderer === "function";
    dialog.classList.toggle("large-editor", mode === "editor" && Boolean(options.large));
    dialog.classList.toggle("monospace-editor", mode === "editor" && Boolean(options.monospace));
    dialog.classList.toggle("markdown-preview-editor", hasPreview);
    title.textContent = options.title || (mode === "confirm" ? "请确认" : "请输入");
    message.textContent = options.message || "";
    message.classList.toggle("hidden", !options.message);
    field.replaceChildren();
    inputControl = null;

    if (mode === "prompt" || mode === "editor") {
      inputControl = document.createElement(mode === "editor" ? "textarea" : "input");
      if (mode === "editor") inputControl.rows = options.rows || 8;
      else inputControl.type = "text";
      if (options.ariaLabel) inputControl.setAttribute("aria-label", options.ariaLabel);
      inputControl.value = options.initialValue || "";
      inputControl.placeholder = options.placeholder || "";
      inputControl.autocomplete = "off";
      if (hasPreview) {
        const split = document.createElement("div"); split.className = "ui-dialog-editor-split";
        const sourcePane = document.createElement("section"); sourcePane.className = "ui-dialog-editor-pane source";
        const sourceLabel = document.createElement("div"); sourceLabel.className = "ui-dialog-editor-pane-label"; sourceLabel.textContent = options.sourceLabel || "Markdown 源码";
        const previewPane = document.createElement("section"); previewPane.className = "ui-dialog-editor-pane preview";
        const previewLabel = document.createElement("div"); previewLabel.className = "ui-dialog-editor-pane-label"; previewLabel.textContent = options.previewLabel || "实时预览";
        const preview = document.createElement("article"); preview.className = "ui-dialog-editor-preview";
        const syncScroll = options.syncScroll !== false;
        const renderPreview = () => {
          previewFrame = null;
          if (!inputControl || !dialog.open) return;
          if (syncScroll) lockScrollTarget(preview);
          options.previewRenderer(preview, inputControl.value);
          if (syncScroll) queueScrollSync(inputControl, preview);
        };
        inputControl.addEventListener("input", () => {
          cancelPreviewFrame();
          previewFrame = requestAnimationFrame(renderPreview);
        });
        if (syncScroll) {
          inputControl.addEventListener("scroll", () => queueScrollSync(inputControl, preview), { passive: true });
          preview.addEventListener("scroll", () => queueScrollSync(preview, inputControl), { passive: true });
        }
        sourcePane.append(sourceLabel, inputControl); previewPane.append(previewLabel, preview);
        split.append(sourcePane, previewPane); field.append(split);
        previewFrame = requestAnimationFrame(renderPreview);
      } else field.append(inputControl);
    } else if (mode === "select") {
      inputControl = document.createElement("select");
      for (const item of options.options || []) {
        const value = typeof item === "string" ? item : (item.value ?? item.id ?? "");
        const label = typeof item === "string" ? item : (item.label ?? item.name ?? value);
        inputControl.append(new Option(label, value));
      }
      const initialValue = typeof options.initialValue === "object"
        ? (options.initialValue?.value ?? options.initialValue?.id ?? "")
        : options.initialValue;
      if (initialValue != null) inputControl.value = initialValue;
      field.append(inputControl);
    }

    confirmButton.textContent = options.confirmText || "确定";
    confirmButton.classList.toggle("danger", Boolean(options.danger));
    cancelButton.textContent = options.cancelText || "取消";
    const result = new Promise((resolve) => { resolveCurrent = resolve; });
    dialog.showModal();
    requestAnimationFrame(() => {
      if (inputControl) {
        inputControl.focus();
        if (mode === "prompt") inputControl.select();
        else if (mode === "editor" && hasPreview) {
          inputControl.setSelectionRange(0, 0);
          inputControl.scrollTop = 0;
        }
      } else confirmButton.focus();
    });
    return result;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (mode === "confirm") settle(true);
    else settle(inputControl?.value ?? "");
  });
  closeButton.addEventListener("click", () => settle(null));
  cancelButton.addEventListener("click", () => settle(null));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); settle(null); });

  return {
    async confirm(messageText, options = {}) {
      return (await open({ ...options, mode: "confirm", message: messageText })) === true;
    },
    prompt(titleText, initialValue = "", options = {}) {
      return open({ ...options, mode: "prompt", title: titleText, initialValue });
    },
    select(titleText, optionsList, options = {}) {
      return open({ ...options, mode: "select", title: titleText, options: optionsList });
    },
    editor(titleText, initialValue = "", options = {}) {
      return open({ ...options, mode: "editor", title: titleText, initialValue });
    },
  };
}
