import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelsController } from '../app/renderer/assistant/models-controller.js';

test('IPC重构不改变供应商及模型的api配置字段', () => {
  const elements = new Proxy({}, { get(target, key) { return target[key] ||= { value: '', checked: false, dataset: {}, options: [] }; } });
  const state = { providerKey: 'fixture', modelIndex: 0, modelsConfig: { providers: { fixture: { api: 'openai-completions', models: [{ id: 'test', api: 'openai-responses' }] } } } };
  elements.providerId.value = 'fixture'; elements.providerApi.value = 'openai-completions';
  elements.modelId.value = 'test'; elements.modelApi.value = 'openai-responses';
  const controller = createModelsController({ state, elements, invoke: async () => ({}), uiDialogs: {}, showNotice() {}, showError() {}, showSettingsToast() {}, loadBootstrap() {}, updateStateFromAgent() {} });
  controller.commitProviderForm();
  const provider = state.modelsConfig.providers.fixture;
  assert.equal(provider.api, 'openai-completions'); assert.equal(provider.models[0].api, 'openai-responses');
  assert.equal('invoke' in provider, false); assert.equal('invoke' in provider.models[0], false);
});
