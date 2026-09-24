export function createAgentUi({command,uiDialogs,input,resize,notice,error}) {
  const active=new Map(),seen=new Set();
  async function handle(request) {
    if(seen.has(request.id))return;
    if(request.id){seen.add(request.id);if(seen.size>512)seen.delete(seen.values().next().value);}
    if(request.method==='notify')return notice(request.message,request.notifyType==='error');
    if(request.method==='setTitle'&&request.title){document.title=request.title;return;}
    if(request.method==='set_editor_text'){input.value=request.text || '';resize();return;}
    const abort=new AbortController();active.set(request.id,abort);
    try {
      const response={type:'extension_ui_response',id:request.id},options={message:request.message || '',placeholder:request.placeholder || '',signal:abort.signal};
      if(request.method==='confirm')response.confirmed=await uiDialogs.confirm(request.message || '',{...options,title:request.title || '确认'});
      else {
        let value;
        if(request.method==='select')value=await uiDialogs.select(request.title || '请选择',request.options || [],{...options,initialValue:request.options?.[0] || ''});
        else if(request.method==='editor')value=await uiDialogs.editor(request.title || '请输入',request.prefill || '',options);
        else if(request.method==='input')value=await uiDialogs.prompt(request.title || '请输入',request.prefill || '',options);
        else return;
        if(value==null)response.cancelled=true;else response.value=value;
      }
      if(!abort.signal.aborted)await command(response);
    }catch(cause){if(!abort.signal.aborted)error(cause);}
    finally{active.delete(request.id);}
  }
  return {handle,reset(){for(const controller of active.values())controller.abort();active.clear();seen.clear();}};
}

export function createAgentRecovery({mount,client,reload,notice}) {
  const bar=document.createElement('div');bar.className='agent-recovery hidden';
  Object.assign(bar.style,{display:'flex',alignItems:'center',gap:'8px',padding:'8px 12px',fontSize:'12px',color:'var(--ui-secondary)'});
  const text=document.createElement('span'),button=document.createElement('button');
  Object.assign(text.style,{flex:'1',minWidth:'0',overflowWrap:'anywhere'});
  Object.assign(button.style,{minHeight:'36px',padding:'0 12px',flexShrink:'0',fontSize:'14px',border:'1px solid var(--ui-border)',borderRadius:'18px',background:'var(--ui-canvas)',color:'var(--ui-text)',cursor:'pointer'});
  button.type='button';button.textContent='重试助手';button.id='retryAgentButton';bar.append(text,button);mount.append(bar);
  button.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;
    try{await client.launch({retry:true});await reload();bar.classList.add('hidden');}
    catch(error){text.textContent=error.message;notice(error.message,true);}
    finally{button.disabled=false;}
  });
  return {event(event){
    if(event.type==='runtime_exit'||event.type==='connected'&&event.state==='error') {text.textContent=event.error || '助手暂不可用，本地工作内容仍可使用。';bar.classList.remove('hidden');}
    if(event.type==='runtime_ready')bar.classList.add('hidden');
  }};
}
