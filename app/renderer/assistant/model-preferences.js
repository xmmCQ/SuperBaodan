import { modelKey, isVisibleInCatalog, supportedThinkingLevels } from '../../shared/model-preferences.js';

export function createModelPreferences({ elements: el, invoke, uiDialogs, showSettingsToast, onCatalog, captureContext = () => () => true }) {
  let catalog = null, display, defaults, savedDisplay, savedDefaults, busy = false, readSequence = 0, confirming = false;
  const displaySnapshot = value => value ? JSON.stringify(value.all ? {all:true} : {all:false,keys:[...value.keys].sort()}) : '';
  const defaultSnapshot = value => JSON.stringify(value || null);
  const displayDirty = () => displaySnapshot(display) !== displaySnapshot(savedDisplay);
  const defaultsDirty = () => defaultSnapshot(defaults) !== defaultSnapshot(savedDefaults);
  const hasDraft = () => Boolean(catalog && (displayDirty() || defaultsDirty()));
  const cloneDisplay = value => ({all:value.all,keys:new Set(value.keys)});
  const visible = (model, draft = display) => draft.all || draft.keys.has(modelKey(model));
  const lockKeys = () => new Set([savedDefaults?.key, defaults?.key].filter(Boolean));
  function protectDefault() { if (display && !display.all) for (const key of lockKeys()) display.keys.add(key); }
  function accept(data, savedGroup = null) {
    readSequence += 1;
    const keepDisplay = displayDirty() && savedGroup !== 'display';
    const keepDefaults = defaultsDirty() && savedGroup !== 'defaults';
    catalog = data;
    const enabled = data.enabledModels || [];
    savedDisplay = {all:enabled.length===0,keys:new Set(data.models.filter(m=>isVisibleInCatalog(m,data)).map(modelKey))};
    for (const key of enabled) if (key.includes('/') && !/[?*]/.test(key)) savedDisplay.keys.add(key);
    savedDefaults = {key:modelKey(data.defaultModel),thinking:data.defaultThinkingLevel || 'off'};
    if (!keepDisplay) display = cloneDisplay(savedDisplay);
    if (!keepDefaults) defaults = {...savedDefaults};
    protectDefault(); render(); onCatalog(data);
  }
  async function load() {
    const request = ++readSequence, current = captureContext();
    let data;
    try { data = await invoke('models.catalog',{}); }
    catch (error) { if (request === readSequence && current()) throw error; return; }
    if (request !== readSequence || !current()) return;
    accept(data);
  }
  function render() {
    if (!catalog) return;
    renderModels(); renderDefaults(); renderStatus(); updateControls();
  }
  function renderModels() {
    if (!catalog) return;
    const query = el.modelPreferencesSearch.value.trim().toLocaleLowerCase();
    const fresh = new Set(catalog.newModelKeys || []), locks = lockKeys();
    const models = [...catalog.models];
    if (savedDefaults.key && !models.some(m=>modelKey(m)===savedDefaults.key)) {
      models.push({...catalog.defaultModel,id:catalog.defaultModel.modelId,name:`${catalog.defaultModel.modelId}（当前不可用）`});
    }
    models.sort((a,b)=>`${a.provider}/${a.name || a.id}`.localeCompare(`${b.provider}/${b.name || b.id}`,undefined,{numeric:true}));
    el.modelPreferencesList.replaceChildren();
    let group;
    for (const model of models) {
      const key = modelKey(model);
      if (query && !`${model.provider} ${model.id} ${model.name || ''}`.toLocaleLowerCase().includes(query)) continue;
      if (group !== model.provider) {
        group = model.provider;
        const heading = document.createElement('h4'); heading.className='model-preference-provider';
        heading.textContent=group==='openai-codex'?'ChatGPT Plus/Pro · openai-codex':group;el.modelPreferencesList.append(heading);
      }
      const row=document.createElement('label');row.className='preference-row';row.dataset.modelKey=key;
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='model-visible';
      checkbox.checked=visible(model);checkbox.disabled=busy||locks.has(key);row.classList.toggle('default-model',locks.has(key));
      checkbox.addEventListener('change',()=>{
        if(display.all)display={all:false,keys:new Set(catalog.models.map(modelKey))};
        if(checkbox.checked)display.keys.add(key);else display.keys.delete(key);
        if(catalog.models.every(m=>display.keys.has(modelKey(m))))display.all=true;
        protectDefault();render();
      });
      const text=document.createElement('span'),name=document.createElement('b'),id=document.createElement('small');
      name.textContent=model.name||model.id;name.dataset.defaultLabel=locks.has(key)?key===savedDefaults.key?' · 默认':' · 待保存默认':'';id.textContent=key;text.append(name,id);row.append(checkbox,text);
      if(fresh.has(key)){const badge=document.createElement('span');badge.className='model-new-badge';badge.textContent='新增';row.append(badge);}
      el.modelPreferencesList.append(row);
    }
    if(!el.modelPreferencesList.childElementCount){const empty=document.createElement('p');empty.className='muted';empty.textContent='没有匹配的可用模型';el.modelPreferencesList.append(empty);}
  }
  function renderDefaults() {
    const selected = defaults.key;
    const choices = catalog.models.filter(m=>isVisibleInCatalog(m,catalog));
    el.defaultModelSelect.replaceChildren();
    if(!choices.some(m=>modelKey(m)===selected)){
      const option=new Option(selected?`${selected}（不可用或未显示，草稿保留）`:'请选择默认模型',selected);option.disabled=true;el.defaultModelSelect.append(option);
    }
    let provider,group;
    for(const model of choices){
      if(provider!==model.provider){provider=model.provider;group=document.createElement('optgroup');group.label=provider;el.defaultModelSelect.append(group);}
      group.append(new Option(model.name || model.id,modelKey(model)));
    }
    el.defaultModelSelect.value=selected;el.defaultModelSelect.title=el.defaultModelSelect.selectedOptions[0]?.textContent || '';
    const model=catalog.models.find(m=>modelKey(m)===selected),levels=supportedThinkingLevels(model);
    el.defaultThinking.replaceChildren(...levels.map(level=>new Option(level,level)));
    if(!levels.includes(defaults.thinking)){
      const option=new Option(`${defaults.thinking}（当前不支持，草稿保留）`,defaults.thinking);option.disabled=true;el.defaultThinking.append(option);
    }
    el.defaultThinking.value=defaults.thinking;
  }
  function renderStatus() {
    const labels={success:'刷新成功',partial:'部分供应商刷新失败',failed:'刷新失败'};
    el.modelRefreshStatus.textContent=busy?'正在处理…':labels[catalog.refresh?.status] || '尚未手动刷新';
    el.modelRefreshTime.textContent=catalog.refresh?.lastSuccessfulAt?`最近成功更新：${new Date(catalog.refresh.lastSuccessfulAt).toLocaleString()}`:'最近成功更新：暂无';
    el.modelRefreshDetails.classList.toggle('hidden',!(catalog.providerResults?.length || catalog.refresh?.runtimeWarning));
    el.modelRefreshDetails.open=(catalog.providerResults || []).some(p=>p.status==='failed') || Boolean(catalog.refresh?.runtimeWarning);
    el.modelRefreshResults.replaceChildren();
    for(const result of catalog.providerResults || []){
      const row=document.createElement('p');row.className=result.status==='failed'?'model-refresh-error':'muted';row.textContent=`${result.provider}：${result.message}`;el.modelRefreshResults.append(row);
    }
    if(catalog.refresh?.runtimeWarning){const warning=document.createElement('p');warning.textContent=catalog.refresh.runtimeWarning;el.modelRefreshResults.append(warning);}
  }
  function updateControls() {
    for(const node of el.preferencesTab.querySelectorAll('button,input,select'))node.disabled=busy;
    for(const row of el.modelPreferencesList.querySelectorAll('.preference-row'))row.querySelector('input').disabled=busy||lockKeys().has(row.dataset.modelKey);
    el.saveModelDisplay.disabled=busy||!displayDirty();el.saveModelDefaults.disabled=busy||!defaultsDirty();
    el.modelDisplayPolicy.textContent=display.all?' 显示全部：新增模型自动显示。':' 手动选择：新增模型默认不勾选。';
    el.modelDisplayDirty.textContent=displayDirty()?'显示设置未保存':'';
    el.modelDefaultsDirty.textContent=defaultsDirty()?'默认设置未保存':'';
  }
  async function operate(command, body, savedGroup) {
    if(busy)return;
    busy=true;if(catalog){renderStatus();updateControls();}
    const current=captureContext();++readSequence;
    try {
      const data=await invoke(command,body);
      if(!current())return;
      accept(data,savedGroup);
      showSettingsToast(savedGroup?'保存成功':data.refresh?.status==='failed'?'刷新失败，已保留旧目录':data.refresh?.status==='partial'?'部分目录已更新，请查看供应商提示':'模型目录已刷新',data.refresh?.status==='failed'?'error':'success');
    } catch(error) {
      if(current()){
        showSettingsToast(error.message,'error');
        if(!savedGroup){
          el.modelRefreshStatus.textContent='刷新失败，已保留旧目录';
          el.modelRefreshDetails.classList.remove('hidden');el.modelRefreshDetails.open=true;
          const reason=document.createElement('p');reason.className='model-refresh-error';reason.textContent=error.message;el.modelRefreshResults.replaceChildren(reason);
        }
      }
    } finally { busy=false;if(catalog){updateControls(); if(el.modelRefreshStatus.textContent==='正在处理…')renderStatus();} }
  }
  function updateVisibility(mode) {
    if(!catalog || busy)return;
    if(mode==='all')display={all:true,keys:new Set(catalog.models.map(modelKey))};
    else display={all:false,keys:new Set(catalog.models.filter(m=>!visible(m)).map(modelKey))};
    protectDefault();render();
  }
  function changeDefault() {
    if (!catalog || busy) return;
    defaults.key=el.defaultModelSelect.value;
    const model=catalog.models.find(m=>modelKey(m)===defaults.key),levels=supportedThinkingLevels(model);
    if(!levels.includes(defaults.thinking))defaults.thinking=levels.includes('high')?'high':levels[0] || 'off';
    protectDefault();render();
  }
  function saveDisplay() {
    if(!catalog || !displayDirty())return;
    if(!display.all && !display.keys.size)return showSettingsToast('至少保留一个模型','error');
    return operate('models.saveDisplay',{enabledModels:display.all?[]:[...display.keys]},'display');
  }
  function saveDefaults() {
    if(!catalog || !defaultsDirty())return;
    const model=catalog.models.find(m=>modelKey(m)===defaults.key);
    if(!model || !isVisibleInCatalog(model,catalog))return showSettingsToast('请先保存显示设置，再选择已显示且可用的模型','error');
    if(!supportedThinkingLevels(model).includes(defaults.thinking))return showSettingsToast('请选择该模型支持的思考等级','error');
    return operate('models.saveDefaults',{defaultModel:{provider:model.provider,modelId:model.id},defaultThinkingLevel:defaults.thinking},'defaults');
  }
  async function canLeave() {
    if(busy){showSettingsToast('正在处理，请稍候','error');return false;}
    if(!hasDraft())return true;
    if(confirming)return false;
    confirming=true;
    try {
      const discard=await uiDialogs.confirm('模型偏好有未保存的修改，是否放弃？',{title:'未保存的模型偏好',confirmText:'放弃修改'});
      if(discard){display=cloneDisplay(savedDisplay);defaults={...savedDefaults};protectDefault();render();}
      return discard;
    } finally { confirming=false; }
  }
  el.modelPreferencesSearch.addEventListener('input',renderModels);
  el.refreshModelCatalog.addEventListener('click',()=>operate('models.refresh',{},null));
  el.selectAllModels.addEventListener('click',()=>updateVisibility('all'));
  el.invertModels.addEventListener('click',()=>updateVisibility('invert'));
  el.defaultModelSelect.addEventListener('change',changeDefault);
  el.defaultThinking.addEventListener('change',()=>{if(defaults&&!busy){defaults.thinking=el.defaultThinking.value;updateControls();}});
  el.saveModelDisplay.addEventListener('click',saveDisplay);
  el.saveModelDefaults.addEventListener('click',saveDefaults);
  return {load,accept,canLeave,hasDraft,isBusy:()=>busy,render,saveDisplay,saveDefaults};
}
