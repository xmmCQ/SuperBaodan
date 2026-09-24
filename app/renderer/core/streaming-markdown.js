import { MAX_MARKDOWN_LENGTH } from '../markdown-renderer.js';

export function updateStreamingText(node, value) {
  const text = node.firstChild;
  if (text?.nodeType === 3 && !text.nextSibling) {
    if (value.startsWith(text.data)) text.appendData(value.slice(text.length));
    else text.data = value;
  } else node.textContent = value;
}

// Freeze completed top-level blocks. Only the active block is reparsed;
// message_end still uses the normal renderer for complete Markdown semantics.
export function createStreamingMarkdown(container, render, options) {
  let source = '', pending = '', active, rendered = '';
  container.classList.add('markdown-body');
  function node() { if (!active) { active = document.createElement('div'); container.append(active); rendered = ''; } return active; }
  function paint(text) {
    const target = node(), delta = text.startsWith(rendered) ? text.slice(rendered.length) : null;
    let last = target.lastElementChild;
    while (last?.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(last.tagName)) last = last.lastElementChild;
    const tail = last?.lastChild;
    // No markup delimiter/newline can change the current inline structure.
    if (delta && rendered && !/[\n\r\\`*_\[\]()<>!|~&;#]/.test(delta) && !(target.firstElementChild?.tagName==='P' && /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(text)) && tail?.nodeType === 3 && /^(P|LI|H[1-6])$/.test(last.tagName) && rendered.endsWith(tail.data)) {
      tail.appendData(delta);
    } else {
      const fence = text.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/), code = target.querySelector?.('pre code');
      const body = fence ? text.slice(fence[0].length) : '';
      const closing = fence && new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`,'m');
      const end = closing?.exec(body);
      if (delta && code && fence && (!end || !body.slice(end.index+end[0].length).trim())) {
        const content = end ? body.slice(0,end.index) : body;
        const value = content.endsWith('\n') ? content : content + '\n';
        const leaf=code.firstChild;
        if (leaf?.nodeType===3 && leaf.data.endsWith('\n') && value.startsWith(leaf.data.slice(0,-1))) leaf.replaceData(leaf.length-1,1,value.slice(leaf.length-1));
        else updateStreamingText(code,value);
      } else render(target,text,options);
    }
    rendered = text;
  }
  return { update(text) {
    if (text === source) return;
    if (text.length > MAX_MARKDOWN_LENGTH) {
      if (text.startsWith(source) && container.dataset.markdownMode === 'plain' && container.firstChild?.nodeType === 3) container.firstChild.appendData(text.slice(source.length));
      else render(container,text,options);
      source=text;pending='';active=null;rendered='';return;
    }
    if (!text.startsWith(source)) { container.replaceChildren(); container.classList.remove('markdown-plain'); delete container.dataset.markdownMode; pending = ''; active = null; rendered = ''; source = ''; }
    pending += text.slice(source.length); source = text;
    let fence = null, compound = false, offset = 0, boundary = 0;
    const lines = pending.split('\n');
    for (let i=0;i<lines.length-1;i++) {
      const line=lines[i], marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) { if (marker && marker[1][0]===fence[0] && marker[1].length>=fence.length && line.slice(marker[0].length).trim()==='') fence=null; }
      else if (marker) fence=marker[1];
      else if (/^ {0,3}(?:[-+*>]|\d+[.)]\s)|^ {4}\S/.test(line)) compound=true;
      offset+=line.length+1;
      if (!fence && !line.trim() && (!compound || /^[A-Za-z\u0080-\uffff#`~]/.test(lines[i+1]))) { boundary=offset; compound=false; }
    }
    if (boundary) { paint(pending.slice(0,boundary)); pending=pending.slice(boundary); active=null; rendered=''; }
    if (pending) paint(pending);
  } };
}
