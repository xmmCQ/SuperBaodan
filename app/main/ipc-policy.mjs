import { serialize } from 'node:v8';
import { COMMANDS, MAX_MESSAGE_BYTES } from '../shared/commands.js';
import { fault } from '../shared/errors.js';
import { isAppUrl } from './resources.mjs';

export function assertTrustedFrame(event, window, startupUrl) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw fault(403, '拒绝未知窗口请求');
  if (event.senderFrame.url !== startupUrl && !isAppUrl(event.senderFrame.url)) throw fault(403, '拒绝未知页面请求');
}

export function validateInvocation(message) {
  if (!message || typeof message.id !== 'string' || !/^[\w-]{1,64}$/.test(message.id) || !COMMANDS.includes(message.name)) throw fault(400, '无效应用操作');
  const args = message.args ?? {};
  if (!args || Object.getPrototypeOf(args) !== Object.prototype) throw fault(400, '参数必须是普通对象');
  const limit = ['files.upload', 'agent.command'].includes(message.name) ? MAX_MESSAGE_BYTES : 1024 * 1024;
  if (serialize(args).byteLength > limit) throw fault(413, '操作内容过大');
  if (message.name === 'files.upload' && !(args.content instanceof Uint8Array)) throw fault(400, '文件内容必须是二进制数据');
  return args;
}
