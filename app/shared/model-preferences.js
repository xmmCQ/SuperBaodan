export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const modelKey = model => model ? `${model.provider}/${model.id ?? model.modelId}` : '';
export function modelScopeMatches(pattern, key, id) {
  if (!pattern) return false;
  const base = String(pattern).split(':')[0];
  if (!base.includes('*') && !base.includes('?')) return base === key || base === id;
  return new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(key);
}
export function isModelVisible(model, enabled = []) {
  return !enabled.length || enabled.some(pattern => modelScopeMatches(pattern, modelKey(model), model.id ?? model.modelId));
}
export function isVisibleInCatalog(model, catalog) {
  return Array.isArray(catalog.visibleModelKeys) ? catalog.visibleModelKeys.includes(modelKey(model)) : isModelVisible(model, catalog.enabledModels || []);
}
export function supportedThinkingLevels(model) {
  if (Array.isArray(model?.thinkingLevels)) return THINKING_LEVELS.filter(level => model.thinkingLevels.includes(level));
  if (!model?.reasoning) return ['off'];
  const levels = new Set(['off', 'minimal', 'low', 'medium', 'high']);
  for (const [level, mapped] of Object.entries(model.thinkingLevelMap || {})) {
    if (mapped == null) levels.delete(level); else levels.add(level);
  }
  return THINKING_LEVELS.filter(level => levels.has(level));
}
