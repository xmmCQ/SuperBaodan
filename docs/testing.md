# 测试入口与维护

## 日常执行

只运行受影响的文件；不要用全量回归替代范围判断。

```sh
npm test -- test-runner settings-ui-optimization
npm run test:integration -- task-store smoke-contract
npm run test:browser -- settings-layout settings-providers
npm run test:browser -- task-card-layout
npm run test:desktop -- desktop-draft-exit
```

| 入口 | 范围 |
| --- | --- |
| `npm test` / `npm run test:unit` | 快速单元、架构及静态安全边界检查 |
| `npm run test:integration` | 真实业务层、临时文件、服务进程及SDK适配测试 |
| `npm run test:browser` | Edge界面场景 |
| `npm run test:desktop` | 实际Electron桌面场景 |
| `npm run test:all` | 所有层级；可追加文件名筛选，跨层运行受影响部分 |
| `npm run test:smoke` | 保留原有服务、IPC和浏览器主链路入口 |
| `npm run test:sdk` | 保留原有显式Windows SDK验收入口 |

每个新入口均支持 `--list`，仅列出将执行的文件。文件名支持子串及多个条件，匹配结果去重；拼错名称直接报错，不静默通过。PowerShell若限制脚本执行，使用 `npm.cmd`，不修改执行策略。

`test/layers.mjs` 显式归类全部测试文件，运行前检查遗漏、重复及失效条目。少量混合测试文件按最高成本依赖归类，保留其完整用例，不为分类拆散竞态或安全测试。真实SDK测试仍遵守各自的环境变量和平台条件；全量入口不等于自动启用所有SDK测试。

## 设置与浏览器测试归属

- `settings-layout.test.mjs`：紧凑布局、长内容滚动、默认设置布局、两页阅读字号。原 `settings-compact`、`settings-scroll`、`preferences-layout` 用例迁入，仍为独立场景。
- `settings-providers.test.mjs`：已配置与常用供应商、搜索、更多分组、无结果提示。
- `settings-ui-optimization.test.mjs`：供应商状态文字的单元测试，不匹配源码写法。
- `ui-unification.test.mjs`：会话菜单、键盘、热区、侧栏及文件面板尺寸，不再重复整套设置布局。
- `skill-editor-browser.test.mjs`：技能编辑布局、完整正文和保存重读。
- `task-card-layout.test.mjs`：任务卡片、日期、图标热区、日历字号。
- `composer-controls.test.mjs`：两页输入框、模型选择、工具栏、目录定位、附件发送停止。
- `home-settings.test.mjs`：首页原地设置、草稿保护，以及助手启动/工作区切换不自动打开设置。
- `helpers/browser-scenario.mjs`：共享服务、独立浏览器配置目录、视口、导航和清理。

每个独立测试仍拥有独立临时数据和浏览器配置。只在同一工作流中复用浏览器：三档字号从原先四次启动改为一次，每个子场景先清理测试偏好。换页显式关闭模拟事件连接，避免BFCache保留SSE连接耗尽HTTP连接池。不通过增加等待时间掩盖泄漏。

## 界面模拟服务的边界

`helpers/smoke-server.mjs` 是界面场景夹具，不是第二套产品服务：

- 任务使用内存记录，只支撑界面增改、日期移动和版本错误分支。
- 模型和思考等级保存于模拟会话状态，读取接口返回更新后的状态；未知命令报错，不一律返回成功。
- 模拟提示回复是固定文本；取消、压缩等成功响应只用于界面展示，不证明真实推理、取消或压缩效果。
- 部分文档、软件入口和项目提示词接口借用真实业务类，但只操作临时目录。
- 不保证原子写入、备份、路径安全、锁、恢复或真实SDK行为；这些仍由原有业务、SDK和桌面测试负责。

`smoke-contract.test.mjs` 将相同任务场景分别交给模拟HTTP接口和真实TaskStore命令层，比对结果及400/409错误契约；模型场景对照真实命令分发器，验证对话标识、返回状态及默认模型不被覆盖。它补充接口校验，不替代底层回归。

## 截图与执行约束

默认 `SUPER_BAODAN_TEST_SCREENSHOTS=failure`：成功不调用截图接口，也不创建图片目录；失败在关闭浏览器前尽力留一张诊断图，每个场景每次执行最多一张。图片仅写入系统临时目录 `sb-test-diagnostics-*`，路径输出到测试日志。截图超时或失败不掩盖原始断言错误。

可设为 `off` 完全禁用截图。只有用户明确要求人工视觉验收时才设为 `visual`，允许保存显式检查点图片，同样只写临时目录；验收完成后清除该环境变量。常规测试不得顺带运行截图脚本或全套视觉验收，具体约束见 `test/AGENTS.md`。

原 `ui-details.test.mjs` 已按功能拆分：技能与任务布局分别迁入对应测试，首页回复气泡样式迁入 `assistant-theme`，工具栏及附件操作迁入 `composer-controls`，助手设置启动规则迁入 `home-settings`。重复的任务增改删除由 `browser-smoke` 覆盖（保留直接删除和数据数量检查），拖动按钮隔离由 `card-order` 覆盖；重复的首页设置原地打开检查已合并。

`agent.snapshot`、`snapshotRequired` 属于状态同步，不属于图片截图；其实现与竞态测试未修改。既有历史验收图片保留，不再被常规测试写入或更新。

## 本次截图整理验证

28项受影响用例分别验证通过。第一次运行发现旧主题用例把设置按钮深蓝色误写为发送按钮蓝色，修正了断言，未改产品配色；该失败仅产生一张临时诊断图。成功复测未新增诊断图片，既有17张验收图片的内容及修改时间均未变化。

未启用人工视觉模式，未执行截图脚本、全量回归或真实Electron验收。截图策略自身的测试使用假图片字节并清理临时文件，不进行额外浏览器截图。106个测试文件均已归类，状态快照、退出、写入和路径安全回归保留。

## 上一轮分层整理验证

移除25处源码/CSS写法断言，将未覆盖的供应商搜索、菜单角色/图标和热区补为行为断言。架构边界、安全约束检查保留；退出、原子写入、路径安全、会话竞态相关测试文件未修改。

36项定向验证通过，覆盖设置、菜单、模型、夹具契约、入口选择，以及受模拟服务影响的任务和浏览器主链路；另复核了npm筛选入口及后补的图标/热区断言。5个分层入口的清单检查通过，当时104个文件均已归类，无遗漏或重复。

未执行全量回归、真实Electron或付费模型测试；不能把本轮定向通过视为所有层级全绿。
