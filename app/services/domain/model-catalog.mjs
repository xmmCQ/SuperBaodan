import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../atomic-file.mjs';
import { fault, publicErrorMessage } from '../../shared/errors.js';
import { modelKey, isModelVisible } from '../../shared/model-preferences.js';

export function readonlyCredentials(values) {
  const deny = async () => { throw fault(409, '授权已过期或需要更新，请在“模型配置”完成登录后重试'); };
  return {
    read: async id => values[id] ? structuredClone(values[id]) : undefined,
    list: async () => Object.entries(values).map(([providerId, value]) => ({providerId, type:value.type})),
    write: deny, delete: deny, modify: deny,
  };
}
const errorMessage = error => publicErrorMessage(error).replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[=:]\s*)[^\s&]+/gi, '$1[凭据已隐藏]').slice(0,500);
const merge = (before, available) => [...new Map([...before, ...available].map(model => [modelKey(model), model])).values()];

export class ModelCatalog {
  constructor(options) { Object.assign(this, options); }
  async metadata() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async runtime() {
    return this.createRuntime({credentials:readonlyCredentials(await this.readCredentials()),allowModelNetwork:false});
  }
  async models(runtime) {
    const levels = await this.thinkingCapabilities();
    return runtime.getAvailableSnapshot().map(model => ({
      provider:model.provider, id:model.id, name:model.name || model.id,
      reasoning:Boolean(model.reasoning), input:model.input || ['text'],
      thinkingLevelMap:model.thinkingLevelMap || null, thinkingLevels:levels(model),
    })).sort((a,b)=>`${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`,undefined,{numeric:true}));
  }
  visibility(models, preferences, metadata) {
    const enabled = preferences.enabledModels || [], discovered = new Set(metadata.discoveredKeys || []);
    const displayAll = enabled.length === 0;
    const visibleModelKeys = models.filter(model => displayAll || modelKey(preferences.defaultModel) === modelKey(model) || (isModelVisible(model,enabled) && (!discovered.has(modelKey(model)) || enabled.includes(modelKey(model)) || enabled.includes(model.id) || modelKey(preferences.defaultModel) === modelKey(model)))).map(modelKey);
    return {displayAll,visibleModelKeys};
  }
  async read() {
    const [runtime, metadata, preferences] = await Promise.all([this.runtime(),this.metadata(),this.preferences()]);
    const failed = new Set((metadata.providers || []).filter(p=>p.status==='failed').map(p=>p.provider));
    const fallback = (metadata.models || []).filter(model=>failed.has(model.provider)&&runtime.getProviderAuthStatus(model.provider).configured);
    const models = merge(fallback,await this.models(runtime));
    return {...preferences,models,...this.visibility(models,preferences,metadata),refresh:metadata.refresh || null,newModelKeys:metadata.newModelKeys || [],providerResults:metadata.providers || []};
  }
  async refresh({signal} = {}) {
    signal?.throwIfAborted();
    const before = await this.read(), runtime = await this.runtime();
    const providers = runtime.getProviders().filter(p=>runtime.getProviderAuthStatus(p.id).configured);
    if (!providers.length) throw fault(400, '尚未配置供应商，请先在“模型配置”完成配置');
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(15000);
    const result = await runtime.refresh({allowNetwork:true,force:true,providers:providers.map(p=>p.id),signal:signal?AbortSignal.any([signal,timeout]):timeout});
    signal?.throwIfAborted();
    const now = new Date().toISOString();
    const outcomes = providers.map(p=>({provider:p.id,status:result.aborted || result.errors.has(p.id)?'failed':'success',
      message:result.errors.has(p.id)?errorMessage(result.errors.get(p.id)):result.aborted?'目录刷新超时，请重试':p.refreshModels?'已刷新':'使用已配置的静态模型目录'}));
    const failed = new Set(outcomes.filter(p=>p.status==='failed').map(p=>p.provider));
    const successes = outcomes.length-failed.size;
    const models = successes ? merge(before.models.filter(m=>failed.has(m.provider)),(await this.models(runtime)).filter(m=>!failed.has(m.provider))) : before.models;
    const known = new Set(before.models.map(modelKey)), previousMetadata = await this.metadata();
    const discoveredKeys = [...new Set([...(previousMetadata.discoveredKeys || []),...models.map(modelKey).filter(key=>!known.has(key))])];
    const metadata = { discoveredKeys,
      models, providers:outcomes, newModelKeys:successes?models.map(modelKey).filter(key=>!known.has(key)):before.newModelKeys || [],
      refresh:{status:successes===0?'failed':failed.size?'partial':'success',attemptedAt:now,lastSuccessfulAt:successes?now:before.refresh?.lastSuccessfulAt || null},
    };
    await mkdir(path.dirname(this.file),{recursive:true});await writeJsonAtomic(this.file,metadata);
    // Reload metadata only. Never setModel, restart a session or resolve OAuth.
    if (successes) {
      try { await this.syncRuntime(); }
      catch (error) {
        metadata.refresh.runtimeWarning=`目录已更新，聊天候选同步失败，请稍后重试：${errorMessage(error)}`;
        await writeJsonAtomic(this.file,metadata);
      }
    }
    const preferences = await this.preferences();
    return {...preferences,models,...this.visibility(models,preferences,metadata),newModelKeys:metadata.newModelKeys,providerResults:outcomes,refresh:metadata.refresh};
  }
}
