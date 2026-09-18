import path from 'node:path';

// Only locations are exposed here. Do not read or preload personal data.
export function applicationDataPrompt(dataPaths) {
  if (!dataPaths) return '';
  const paths = {};
  for (const key of ['todoFile', 'dailyRecordFile']) {
    const value = dataPaths[key];
    if (typeof value !== 'string' || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) {
      throw new Error(`应用数据路径无效：${key}`);
    }
    paths[key] = value;
  }
  return `## 超级宝蛋当前应用数据位置
以下路径由应用运行配置提供，与工作日历界面使用同一份数据；不随当前工作区改变。
${JSON.stringify(paths, null, 2)}
todoFile 是工作待办文件；dailyRecordFile 是每日记录文件。
涉及应用数据时，以此处路径为准，不沿用技能或历史对话中的旧路径，不根据安装目录、工作区或文件名猜测路径。
这里只提供位置，并未读取文件。仅在用户请求今日安排、本周总结、下周计划等需要待办数据的任务时，用读取工具读取 todoFile 最新内容；无关问题不要读取。
本周总结默认只使用工作待办，不自动混入每日记录；仅在用户需要每日记录时读取 dailyRecordFile。
读取失败或文件缺失时明确说明，不回退到旧目录、备份或缓存，不把读取失败当成没有事项。未经用户明确要求，不修改数据文件。`;
}
