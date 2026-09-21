# 代码精简与结构优化执行记录

## 范围

基于本地 0.0.5 桌面版完成六批调整。保留上一轮后台退出保护、工作区快照队列、搜索取消链路和目录按需加载修复。

没有更新 README、版本和依赖清单，没有读写个人配置、凭据、工作记录或聊天目录，没有打包、提交或上传 Git。原 Web 项目未修改。

## 各批职责与兼容行为

1. **无效代码**：删除未使用的 `isAppUrl` 导入、首页 `liveText` 缓冲和五处空展开；逐项展开剩余对象包装，保留字段求值与覆盖顺序。首页 `message_update` 的上下文检查、工作指示及快照恢复通知保留。卸载仍先验证安装记录，失败不执行 CLI。
2. **控制器接口**：首页对外方法由36项减至26项，完整助手43项减至28项，文件面板18项减至14项。内部 DOM 构造函数仍在原模块中，不增加全局接口；实际生产及行为测试使用的方法保留。移除仅为返回项存在的图片读取导入和附件渲染别名。
3. **公共工具**：复用现有 `shared/errors.js` 的 `fault`，删除待办和模型管理中的旧错误工厂。消息优先参数、默认错误码及图片错误的 `status` 别名通过窄适配保留，不改系统异常的原始 `code`。每日记录与固定提示词共用 `writeJsonAtomic`；保留两空格缩进、末尾换行、UUID临时文件名、0o600模式，以及各管理器自己的初始化、队列、备份和版本校验。
4. **初始化加载**：完整助手复用 `createBootstrapLoader`，在模型偏好读取后及文件树刷新后检查 `current()`。准备提示、最新错误提示、消息/模型/会话应用顺序和运行中会话的响应兜底保留；旧请求不能覆盖新页面。
5. **RuntimeContext**：待办读取、最近有效数据、版本冲突、串行写入、备份及清理移入 `TaskStore`；退出通过 `whenIdle()` 等待已受理写入。PowerShell软件启动移入独立函数，通过可替换执行器测试；软件清单仍以Base64标准输入传递，参数、超时和返回格式不变。RuntimeContext继续承担服务装配、工作区切换及退出协调。
6. **Skill及模型管理**：Markdown规则、CLI调用、SDK定位加载、模型配置纯规则分别移入独立模块。SkillManager保留安全检查、备份、回滚和业务编排；所有变更仍通过原来的 `piAdmin.withMaintenance()`。PiAdmin保留OAuth、凭据落盘及运行时维护。密钥占位符和配置文件位置不变；调用方已迁移，不保留旧路径兼容导出。

阶段测试曾发现测试夹具的导入匹配失配、首页旧缓冲断言失配及同名技能解析依赖漏接，均已修正。首页用例改为校验实际工作指示、DOM身份及最终回复，旧响应隔离与并发保护断言保留。

## 发送行为记录（本轮未改）

- 首页只发送文字；明确拒绝时保留原有错误展示并恢复引用，不新增输入框草稿恢复规则。
- 完整助手支持文字与图片；明确拒绝时，在同一工作区内撤回乐观消息，恢复附件、引用及未被新输入占用的文字草稿。
- 受理状态未知时，两端沿用各自的状态恢复/响应兜底，不误当成明确拒绝。
- 完整助手的发送错误回调有显式scope检查，首页沿用当前AgentClient及页面处理方式。本轮只记录差异，没有增加共享发送抽象或变更草稿规则。

## 实际测试

全部使用临时文件、模拟运行时及隔离浏览器。Windows PowerShell执行；完整测试使用 `npm.cmd test`，绕过 npm.ps1 的系统执行策略限制，未修改该策略。

| 测试批次 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| 第一批定向 | 25 | 0 | 0 |
| 第二批定向 | 51 | 0 | 0 |
| 第三批定向及取消/工作区补充回归 | 56 | 0 | 0 |
| 第四批定向及浏览器/慢连接补充回归 | 52 | 0 | 0 |
| 第五批定向及TaskStore新增用例 | 43 | 0 | 0 |
| 第六批定向及CLI新增用例 | 54 | 0 | 1 |
| 方案列出的跨模块重点回归 | 73 | 0 | 0 |
| 最终全量，共379项 | 375 | 0 | 4 |

首轮全量曾出现聊天分页用例等待100条消息超时：374通过、1失败、4跳过。该文件单独复跑2项通过，之后完整重跑得到上述最终结果。没有修改分页实现、放宽等待阈值或删除相关断言。

四项跳过均为真实SDK联调：应用路径上下文、Windows SDK综合集成、同名Skill真实加载、BaodanPark真实加载。必须显式设置 `SUPER_BAODAN_TEST_SDK=1` 才启用；本轮将原先自动运行的Park真实SDK用例也改为同样的显式开关，原有断言保留。

## 静态检查

- 232个自有代码/测试/脚本文件通过 `node --check`。
- 129个应用自有JS模块的静态导入图未发现循环、失效路径或服务层反向导入界面层。
- 自有模块具名导入检查无缺失导出；未发现新增的单次引用具名导入。
- 应用源码不再包含旧 `mutationError`、`statusError`、首页 `state.liveText` 或 `...({` 包装。
- README、package.json及锁文件与本轮开始时一致。

这些检查不等同于真实安装包或真实模型验证。

## 未验证及后续事项

- 未执行真实模型、真实OAuth账号或真实SDK联调，未制作或验证安装包。
- 聊天分页浏览器测试仍有既有时序波动，留待单独定位，不在结构调整中修改产品行为。
- 两端发送失败后的草稿处理策略不同；如需统一，先明确产品规则，再独立实施。

## 文件清单

下列清单相对于本轮开始时的源码快照；没有删除文件。

### 新增（11个）

- `app/services/atomic-file.mjs`
- `app/services/domain/launch-work-apps.mjs`
- `app/services/domain/model-config.mjs`
- `app/services/domain/pi-sdk-loader.mjs`
- `app/services/domain/skill-cli.mjs`
- `app/services/domain/skill-markdown.mjs`
- `app/services/domain/task-store.mjs`
- `docs/refactor-execution-report.md`
- `test/atomic-file.test.mjs`
- `test/skill-cli.test.mjs`
- `test/task-store.test.mjs`

### 修改（56个）

- `app/main/main.mjs`
- `app/renderer/assistant/auth-controller.js`
- `app/renderer/assistant/chat-view.js`
- `app/renderer/assistant/main.js`
- `app/renderer/assistant/models-controller.js`
- `app/renderer/assistant/project-prompt.js`
- `app/renderer/assistant/skills-controller.js`
- `app/renderer/assistant/workspace-controller.js`
- `app/renderer/core/bootstrap-loader.js`
- `app/renderer/home/daily-records.js`
- `app/renderer/home/home-chat.js`
- `app/renderer/home/state.js`
- `app/renderer/home/tasks.js`
- `app/renderer/home/vskills.js`
- `app/renderer/home/work-apps.js`
- `app/renderer/home/work-documents.js`
- `app/renderer/workspace-switcher.js`
- `app/services/commands/agent.mjs`
- `app/services/commands/sessions.mjs`
- `app/services/commands/system.mjs`
- `app/services/commands/tasks.mjs`
- `app/services/commands/workspaces.mjs`
- `app/services/domain/daily-record-manager.mjs`
- `app/services/domain/holiday-calendar.mjs`
- `app/services/domain/open-skill-directory.mjs`
- `app/services/domain/pi-admin.mjs`
- `app/services/domain/pi-sdk-factory.mjs`
- `app/services/domain/pi-sdk.mjs`
- `app/services/domain/project-prompt.mjs`
- `app/services/domain/session-text-search.mjs`
- `app/services/domain/skill-directory-cache.mjs`
- `app/services/domain/skill-manager.mjs`
- `app/services/domain/skill-transfer.mjs`
- `app/services/domain/task-writer.mjs`
- `app/services/domain/vskill-manager.mjs`
- `app/services/domain/work-apps.mjs`
- `app/services/domain/workspace-layout.mjs`
- `app/services/domain/workspace-registry.mjs`
- `app/services/domain/workspace-resources.mjs`
- `app/services/domain/workspace.mjs`
- `app/services/prompt-receipts.mjs`
- `app/services/runtime-context.mjs`
- `app/services/ui-event-payloads.mjs`
- `app/services/workspace-operations.mjs`
- `app/shared/prompt-images.js`
- `app/shared/work-documents.js`
- `test/bootstrap-races.test.mjs`
- `test/chat-scroll-follow.test.mjs`
- `test/helpers/chat-consumer.mjs`
- `test/pi-admin.test.mjs`
- `test/session-sync-races.test.mjs`
- `test/skill-collisions.test.mjs`
- `test/skill-manager.test.mjs`
- `test/skill-transfer.test.mjs`
- `test/work-apps.test.mjs`
- `test/workspace-layout-sdk.test.mjs`

### 删除

无。
