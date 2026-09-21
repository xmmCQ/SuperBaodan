import test from 'node:test';
import assert from 'node:assert/strict';
import { FileActions } from '../app/main/file-actions.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

test('原生文件选择返回完整路径和名称，不调用PowerShell', async t => {
  if (process.platform !== 'win32') return t.skip('Windows路径约束');
  const temp = await createTempProject('sb-native-picker-'); t.after(() => temp.cleanup());
  const file = temp.resolve('测试文档.txt'); await writeFile(file, 'isolated');
  const owner = {}; let options;
  const actions = new FileActions({ getWindow: () => owner, dialog: { async showOpenDialog(window, value) { assert.equal(window, owner); options = value; return { canceled: false, filePaths: [file] }; } } });
  const result = await actions.pick(); assert.equal(result.path, file); assert.equal(result.name, path.basename(file));
  assert.deepEqual(options.properties, ['openFile']);
});
