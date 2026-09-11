import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelsController } from '../public/assistant/models-controller.js';

function node() {
  const classes = new Set();
  return { textContent: '', value: '', classList: {
    add: (name) => classes.add(name),
    toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
    contains: (name) => classes.has(name),
  }, append() {}, replaceChildren() {}, addEventListener() {} };
}
test('未配置或注销隐藏模型/思考，登录显示，合法 off 不隐藏', (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: node };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const picker = node();
  const elements = Object.fromEntries(['modelFilter','modelPickerList','modelPickerButton','modelPickerPanel','thinkingSelect'].map((id) => [id, node()]));
  elements.modelPickerButton.closest = () => picker;
  const state = { enabledModels: [], models: [], currentModel: null };
  const controller = createModelsController({ state, elements });
  controller.renderModels([], {provider:'unknown', id:'unknown'});
  assert.ok(picker.classList.contains('hidden'));
  assert.ok(elements.thinkingSelect.classList.contains('hidden'));
  assert.equal(elements.modelPickerButton.textContent, '选择模型');
  const model = {provider:'test', id:'test-model', name:'Test'};
  controller.renderModels([model], model);
  controller.applyAgentState({ model, thinkingLevel:'off' });
  assert.equal(picker.classList.contains('hidden'), false);
  assert.equal(elements.thinkingSelect.classList.contains('hidden'), false);
  assert.equal(elements.thinkingSelect.value, 'off');
  controller.renderModels([], model);
  assert.ok(picker.classList.contains('hidden'));
  assert.ok(elements.thinkingSelect.classList.contains('hidden'));
  assert.ok(elements.modelPickerPanel.classList.contains('hidden'));
  controller.renderModels([model], null);
  assert.equal(picker.classList.contains('hidden'), false);
  assert.ok(elements.thinkingSelect.classList.contains('hidden'));
});
