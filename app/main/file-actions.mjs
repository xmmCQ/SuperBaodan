import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { normalizeTarget } from '../shared/work-documents.js';
import { fault } from '../shared/errors.js';

export class FileActions {
  constructor({ dialog, getWindow }) { this.dialog = dialog; this.getWindow = getWindow; this.picking = false; }
  async pick(signal) {
    if (this.picking) throw fault(409, '已有文件选择窗口');
    if (signal?.aborted) throw fault(499, '已取消文件选择');
    this.picking = true;
    try {
      const result = await this.dialog.showOpenDialog(this.getWindow(), { title: '选择工作文档', properties: ['openFile'], filters: [{ name: '工作文档', extensions: ['doc','docx','xls','xlsx','ppt','pptx','pdf','txt','md','csv','rtf','wps','et','dps','png','jpg','jpeg','webp'] }] });
      if (signal?.aborted || result.canceled) return { cancelled: true };
      const file = normalizeTarget('file', result.filePaths[0]);
      const real = await realpath(file);
      if (!(await stat(real)).isFile()) throw fault(400, '请选择普通文件');
      return { cancelled: false, path: file, name: path.basename(file) };
    } finally { this.picking = false; }
  }
}
