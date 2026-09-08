# 超级宝蛋

参考 pi-web 的架构自行实现的轻量 Windows 原生工作台，**未安装、复制或依赖 pi-web**。

## 架构

```text
Windows 快捷方式 → node.exe launcher.mjs（不经过 PowerShell）
       │
       ▼
浏览器
├─ 首页：日历、待办、工作软件
└─ 自研完整助手界面：/assistant.html
       │ REST 命令 + SSE 实时事件
       ▼
SuperBaodan Windows Node 服务
       │ 进程内调用 / 事件订阅
       ▼
Windows Pi SDK：AgentSessionRuntime（与服务同进程）
```

借鉴 pi-web 的部分：会话与运行时分离、命令与事件分离、实时工具状态、刷新后状态恢复。界面和服务端均为 SuperBaodan 自己实现。

## 运行环境

- Windows Node.js 22.19 或以上
- Windows Pi 0.84.4
- 不依赖 WSL
- 不需要项目本地 `node_modules`
- 运行入口为 Windows `node.exe`，不使用 PowerShell 启动工作台或 Pi

Windows Pi 安装命令：

```powershell
npm.cmd install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
```

Pi 标准配置：

```text
C:\Users\niuli2288\.pi\agent
```

## 功能

工作台保留：

- 工作日历、当日详情、遗留工作、长期工作
- 待办新增、编辑、完成、删除和拖动改期
- 中国大陆休班标识：普通周末和放假日显示“休”，调休工作日显示“班”；补班优先于周末判断。日期选择、待办点标及拖动改期不变，当日详情最小宽度仍为370px。
- 节假日通过 `GET /api/holidays?year=2026` 按年异步读取，不阻塞日历显示。不安装 `holiday-calendar` npm包、不加载外部脚本；Windows Node原生fetch依次读取 `https://gcore.jsdelivr.net/gh/cg-zhou/holiday-calendar@main/data/CN/{year}.json`、`https://unpkg.com/holiday-calendar/data/CN/{year}.json`。这是第三方整理数据，不是官方接口或银行专属排班。2026年接口于2026-09-08在Windows Node中实测可用，返回39条特殊日期；后续可用性和准确性仍取决于数据源。
- 缓存位于 `data/holiday-cache/{year}.json`，含来源和获取时间；24小时有效，过期缓存先展示并在后台更新，失败保留最后成功数据，5分钟后允许重试。前端按需读取，年度结果在页面内缓存5分钟；浏览器localStorage（`super-baodan.holidays.v1`）另保存最近成功获取的最多12个年度快照。刷新页面时同步显示浏览器缓存，再后台检查本地接口，成功后更新标识；网络失败、无数据或无效响应不清空已有标识，也不以较旧数据覆盖新快照。损坏或被禁用的浏览器缓存安全忽略，保存失败保留当前页面数据并提示。首次使用且无任何缓存时仍需获取数据；彻底验证冷启动需同时清理浏览器快照和服务端文件缓存。未获取某年数据时不猜测休班，显示提示。跨年日历格分别读取对应年份。源文件校验地区、年份、真实日期、类型、重复项和体积，错误响应不覆盖缓存；缓存写入失败保留内存数据并提示。接口新增需要完整重启工作台后刷新页面。
- 当日详情的工作安排、每日记录均可直接拖动卡片上下排序，聚焦卡片后也可按Alt+↑/↓移动；同一待办卡片拖到列表中排序、拖到日历日期改期，由落点决定操作，不额外显示拖动手柄。编辑、删除等操作按钮不启动拖拽。排序按日期、列表分别保存在当前浏览器localStorage（`super-baodan.day-order.v1.*`），不修改待办Markdown、记录数据或日期；跨日期记录搜索不提供排序。
- 首次排序前沿用原排序，新识别的卡片追加到已排序卡片之后。待办显示身份不依赖易变的行号/完成标记，界面改名可迁移当前日期排序；外部直接改名可能按新卡片处理。读取损坏偏好时使用默认顺序，保存失败时保留当前页面排序并提示。
- 首页每日记录：按日期维护多条会议纪要或工作记录，支持 Markdown、日历标记、历史搜索及交给宝蛋整理
- 内部工作待办和每日记录的版本冲突校验
- 写入前备份，最多 30 份
- 一键打开语雀、微信和钉钉
- 原宝蛋视觉样式

自研 Windows Pi 助手当前支持：

- Pi SDK 进程内运行时，复用已安装的 Windows Pi，不另起 Pi CLI 子进程
- REST 命令与 SSE 实时事件
- 首页工作助手可原地流式对话，不再强制跳转；模型、账号、思考等级与展开助手共用
- 首页可新建、切换、重命名和删除历史会话，运行中可直接停止
- 首页 VSkill：配置“名称 + 固定文字 Prompt”，在输入框上方一键发送；首次提供“本周总结”和“下周工作”两个默认项
- 三栏助手工作区：左侧会话、中间聊天、右侧文件；右栏默认折叠，可按需打开
- 展开助手的“设置 → 阅读设置”提供统一阅读偏好：小/标准/大字号、标准/宽版正文以及恢复默认。标准保留现有样式（首页13px、展开助手14px），小号12px、大号18px；仅作用于聊天阅读区域，偏好在本机浏览器保存，两处页面共享。
- 左侧会话栏右边缘可实时拖动，宽度默认195px、通常限制在180–420px，并受当前文件面板宽度约束，聊天区至少保留520px。记忆宽度，双击或Home恢复默认，左右键每次调整20px；复用单次阅读锚点捕获，结束/取消拖动后恢复交互。
- 文件面板分隔线可拖动，双击恢复330px，支持键盘左右键调整及Home复位。宽度按实际布局限制为约280–960px，同时给聊天区保留至少520px；记忆上次宽度，拖动结束/取消时恢复鼠标和文本选择。
- 文件预览支持临时放大及文件树折叠；调整阅读设置或面板布局时按可见段落恢复阅读位置。放大不重建文件内容，退出后恢复原面板宽度。
- 已打开文件以标签显示：同一路径不重复创建，同名文件显示所在目录，悬停查看完整路径。每个文件独立保留阅读位置，PDF沿用原iframe；关闭标签释放内容。标签仅保留在当前页面，切换工作区时取消旧请求并清空旧标签，防止路径混用。不引入终端标签、复杂分屏或Git功能。
- 安全多工作区：可添加、搜索、切换、重命名和移除本机目录；首页与展开助手共享当前工作区，每个工作区独立恢复最后会话
- 历史会话按工作区隔离，支持搜索、Pi 原生会话重命名和首条用户消息自动标题
- 首页及展开助手的正文搜索仅扫描当前工作区已落盘历史中的用户/助手text，排除工具日志、思考内容、工具参数和图片Base64。命中包含sessionId、entryId、JSONL行号、可确定的消息序号、时间和片段，可打开对应会话。
- 正文搜索默认预算为2秒、16MiB读取量、300个候选文件、50条命中，单行超过512KiB跳过并标记不完整。输入变化时取消旧请求，服务端同步停止读取；预算耗尽、文件变化或部分记录无法读取时显示“结果未完整扫描”，保留已找到的片段，不伪装成无结果。工作台最多同时运行两次正文扫描，不依赖数据库。
- 会话列表按文件路径、大小及修改时间缓存元信息，首条摘要最多240字符；未变文件只检查stat，新建或变更文件逐行扫描，最多4路并发。同一目录的并发请求合并扫描，写入后主动失效，外部编辑仍通过stat检测；不缓存整份对话，不引入数据库。
- 首页与展开助手安全渲染 Markdown，支持标题、列表、表格、引用、链接和可复制代码块；事件断线时自动同步最终消息
- 流式文本、思考过程、工具调用及工具状态
- 展开助手按提问轮次合并“查看执行过程”：思考、工具参数、完整工具日志及明确以toolUse结束的执行说明默认收起，最终正文和本轮涉及文件保持在外。失败步骤标红并默认展开；用户手动开关优先，流式更新及同会话消息同步保留展开状态和阅读位置。
- 状态区分正在执行、正在重试、正在停止、已停止、执行失败和已完成；成功必须有明确stop终态，旧记录缺少终态时标注“完成状态未确认”。调用数来自真实工具调用/事件，不生成模拟步骤或进度百分比。文件卡片保留涉及文件，只有write/edit调用配对到明确成功的工具结果时才标注“已确认修改”，不把启动时登记的写入尝试宣称为成功。
- 历史分页保留原消息索引，目录定位到已收起的执行说明时先展开对应过程。工具日志完整保留并独立滚动；复制/引用正文排除执行过程内容。
- 首页和展开助手的文字回复支持悬停/键盘聚焦操作栏：复制整条回复原文（保留Markdown）及引用追问，复制成功短暂反馈；不复制按钮、状态、思考和工具信息，原有代码块复制保持不变。
- 在同一条回复内选中文字，可“引用选中内容追问”。引用在输入框旁独立展示，与新指令明确分隔，不覆盖已有草稿、不另开会话；发送后清除引用，新会话/工作区切换时也会清理。导出Markdown暂未加入。
- 首页和展开助手首次只渲染最近50条消息，上翻至顶部每次补充50条，并保持原消息的屏幕位置；流式回复仍在底部更新。此为前端分批渲染，不改变会话存储或API返回范围。
- 顶部“目录”提供默认收起的简版对话目录：按用户提问列出轮次，较长/多标题回复列出一级、二级标题（忽略代码块中的假标题及三级标题）。当前所在轮次高亮，支持“回到最新回复”；目录随已同步的对话更新，不因新消息自动跳走。
- 目录跳转与50条分页共用加载逻辑，先逐批补齐目标消息，再定位；加载期间允许取消，切换对话后旧跳转失效。超长Markdown降级为纯文本时不生成无效标题链接，不引入完整小地图或会话分支。
- 可搜索、按供应商分组的模型选择器与完整思考等级切换
- ChatGPT Plus/Pro（Codex）等 OAuth 登录、状态查看、重新登录和退出
- Pi 内置供应商 API Key 登录与删除（密钥不回显）
- 自定义供应商和模型的新增、复制、删除、完整参数编辑及连接测试
- 默认模型、默认/每模型思考等级和可见模型范围管理
- 登录或模型配置更新后自动恢复原 Pi 会话并刷新模型
- 图片输入
- 工作区安全文件树、文件名搜索与多文件上传，支持同名文件覆盖/跳过选择，以及文本、Markdown、代码、图片和 PDF 预览
- 输入框 `@文件名` 可搜索并插入当前工作区文件的相对路径；文件访问和上传仅限用户明确登记的当前工作区，拒绝路径穿越和符号链接逃逸，并执行类型、数量与大小限制
- 对话轮次识别 Pi `read`/`edit`/`write` 工具路径，聊天与右栏显示本轮涉及/修改文件
- 运行中追加的消息统一在当前任务完成后处理
- 停止、上下文压缩
- Skill 管理：按项目/全局/只读来源分组查看，支持 skills.sh 搜索、安装、更新、卸载、自动调用显隐，以及本地自定义 Skill 的创建、结构化/原始 Markdown 编辑和删除
- Prompt Templates、扩展 Slash Commands
- 扩展 confirm/select/input/editor 交互
- Windows PowerShell 及 Pi 内置文件工具
- 终端输出防护由 Pi 用户目录中的独立扩展 `shell-output-guard` 提供：提示Bash使用 `/dev/null`、PowerShell使用 `$null`，通过 `tool_call` / `user_bash` Hook 阻止误写的 `>nul`。超级宝蛋不再内置重复拦截；源码备份及安装说明见 `extras/pi-extensions/shell-output-guard/`。使用其他Agent目录需另行安装，不是完整Shell沙箱。
- Pi 空闲 10 分钟自动休眠，下次对话自动恢复原会话

## 运行与退出机制

- 打开工作台首页时自动启动 Windows Pi。
- 对话、工具、压缩或重试期间不会自动关闭 Pi。
- 最后一次 Pi 活动 10 分钟后，释放活动 SDK 会话、订阅和扩展资源；工作台 Node 服务继续运行。已加载的 SDK 模块仍留在进程中。
- 健康检查和 SSE 心跳不计为 Pi 活动，不会阻止休眠。
- Pi 休眠后再次发送消息或打开助手，会自动启动并恢复当前会话。
- “退出工作台”按钮同时关闭 Pi 和 Node 服务。
- 可通过 `SUPER_BAODAN_PI_IDLE_MS` 调整空闲时间；默认值为 `600000`。
- 保留单活动 Agent，不增加多 Agent 并发。REST/SSE、历史 JSONL、图片、模型设置和现有界面保持兼容；无需迁移历史数据。
- 活动状态下，同工作区历史会话切换复用 SDK 运行时宿主，调用 `switchSession()`，不走工作台的停止/启动流程；重复选择当前会话直接返回。SDK 仍会执行会话 shutdown/start 和扩展重绑定，不能保证零等待。休眠后选择历史会话仍需初始化。
- 关闭时取消排队及扩展弹窗，等待生成/命令结束，触发扩展 shutdown，释放 SDK 并保存设置。清理超过 5 秒会报错并阻止新 Agent 启动，待旧任务释放后才可恢复；持续无响应需重启工作台，不再通过强杀 Pi 子进程回收。
- SDK 与 HTTP 服务共进程，扩展崩溃或阻塞可能影响工作台；扩展应使用 `ctx.cwd`，不要依赖 `process.cwd()` 或调用 `process.exit()`。
- 沿用已登记工作区的扩展信任策略。终端自定义组件不受 Web 界面支持；标准 confirm/select/input/editor 弹窗继续支持，并在 SSE 重连时补发尚未完成的请求。
- 更新运行层后请退出并重新打开工作台，已运行的旧服务不会自动热切换。

## 慢连接与降级恢复

- 助手降级轮询单请求执行，完成后再等待1500ms；收到事件后的1800ms内不轮询。先读轻量状态和消息版本，版本变化才获取消息快照；思考增量不单独推动全文同步。
- 普通GET/HEAD默认15秒可取消超时，读取型Agent命令也有15秒期限。Prompt、压缩、扩展交互不机械套用该期限；可能等待扩展启动弹窗的bootstrap明确不设同样期限。
- 客户端取消请求只停止等待，不会停止服务端Agent。Prompt携带请求ID，断线或5xx后查询受理回执；收到、受理和整轮完成是不同阶段，不自动重发未知状态的消息。
- 受理回执仅存内存，最多256条，已完成回执保留15分钟；重复ID和相同内容不重复执行，内容不同则拒绝。重启、过期或查不到时仍标记未知，不能据此判定发送失败。
- Agent SSE每连接缓冲上限256KiB，尊重`write()`返回值并等待`drain`；超过上限或阻塞15秒则断开该连接，不影响其他客户端。客户端重连后同步消息快照，包括生成中的会话。

## 目录与数据

```text
D:\Program Files\SuperBaodan
├─ launcher.mjs            Windows Node 原生启动器
├─ server.mjs              服务启动与优雅退出入口
├─ server\app.mjs          HTTP应用装配、维护锁和静态文件回退
├─ server\router.mjs       无第三方依赖的轻量路由表
├─ server\runtime-context.mjs  Pi、工作区、SSE和写入队列运行时上下文
├─ server\routes           Agent、会话、认证、模型、Skill、工作区、待办和每日记录路由
├─ lib\pi-sdk.mjs          SDK会话生命周期、请求受理、休眠与清理
├─ lib\pi-sdk-factory.mjs  Windows SDK加载、配置及运行环境
├─ lib\pi-sdk-commands.mjs 现有命令到SDK方法的适配
├─ lib\pi-sdk-ui.mjs       SDK增量事件和扩展Web交互适配
├─ lib\pi-session-store.mjs 不启动Agent的会话列表及路径校验
├─ lib\pi-admin.mjs        登录、凭据和模型配置管理
├─ lib\skill-manager.mjs   Skill发现、编辑、skills.sh及路径安全管理
├─ lib\vskill-manager.mjs  首页固定Prompt的持久化与校验
├─ lib\daily-record-manager.mjs  每日记录持久化、搜索、备份与版本校验
├─ lib\workspace.mjs       工作区路径安全、预览与搜索
├─ public\app.js           首页模块入口
├─ public\home             首页日历、待办、每日记录、对话和VSkill模块
├─ public\assistant.js     展开助手模块入口
├─ public\assistant        聊天、会话、模型、认证、Skill、工作区和设置模块
├─ public\assistant.css    自研三栏助手界面样式
├─ public\assistant-tokens.css  展开助手颜色、圆角、阴影等设计变量
├─ public\core             首页与展开助手共享的API、Agent、SSE和会话客户端
├─ public\markdown-*       共享 Markdown 渲染与样式
├─ public\vendor           内置 markdown-it 及许可证
├─ public\                 原工作台
├─ test\helpers            可控SDK会话、临时项目、Edge CDP和冒烟服务
├─ test\product-constraints.test.mjs  集中的产品边界约束
├─ test\browser-smoke.test.mjs  临时数据与独立端口的六条浏览器主链路
├─ data\sessions           独立 Pi 会话
├─ data\vskills.json       首页 VSkill 配置
├─ data\daily-records.json 首页每日记录（所有工作区共享）
├─ data\work-todo.md       首页工作待办数据
├─ data\backups            工作待办、每日记录及配置备份
└─ workspace               默认 Pi 工作目录
```

工作待办和每日记录已内化到超级宝蛋目录：

```text
D:\Program Files\SuperBaodan\data\work-todo.md
D:\Program Files\SuperBaodan\data\daily-records.json
```

每日记录在所有工作区之间共享；仅在用户点击“交给宝蛋”时，其内容才会发送到当前首页对话。

原项目 `D:\Program Files\Baodan` 不会被修改。

登录凭据、模型配置和默认模型继续使用 Pi 标准目录：

```text
C:\Users\niuli2288\.pi\agent\auth.json
C:\Users\niuli2288\.pi\agent\models.json
C:\Users\niuli2288\.pi\agent\settings.json
```

保存凭据或模型配置前会在该目录创建带时间戳的备份。接口不会返回 API Key、OAuth token 或敏感请求头。

## 启动

桌面快捷方式直接执行：

```text
C:\Program Files\nodejs\node.exe "D:\Program Files\SuperBaodan\launcher.mjs"
```

`launcher.mjs` 检查服务、按需启动 `server.mjs`，再按 pi-web 的方式调用 Windows `cmd.exe /c start` 打开浏览器。整个运行链路不经过 PowerShell。

访问：<http://127.0.0.1:3211>

创建或更新桌面快捷方式（该脚本只执行一次用于写入 `.lnk`，不是运行入口）：

```powershell
powershell -ExecutionPolicy Bypass -File 'D:\Program Files\SuperBaodan\install-shortcut.ps1'
```

## 验证

```powershell
cd 'D:\Program Files\SuperBaodan'
node --check launcher.mjs
node --check server.mjs
node --check lib\pi-sdk.mjs
node --check lib\pi-admin.mjs
node --check lib\skill-manager.mjs
node --check lib\agent-commands.mjs
node --check lib\workspace.mjs
node --check public\app.js
node --check public\home\main.js
node --check public\assistant.js
node --check public\assistant\main.js
npm.cmd test
npm.cmd run test:smoke
```

Linux/WSL 下等价验证命令：

```bash
node --check server.mjs
node --check lib/pi-sdk.mjs
node --check lib/skill-manager.mjs
node --check lib/workspace.mjs
node --check public/app.js
node --check public/home/main.js
node --check public/assistant.js
node --check public/assistant/main.js
npm test
npm run test:smoke
```

`npm test`包含纯逻辑测试和Edge浏览器冒烟测试。浏览器测试会启动临时HTTP服务、独立端口及临时浏览器配置，不读取或修改正式待办、会话、工作区和Pi配置；未安装Microsoft Edge时自动跳过浏览器部分。

Windows 下可另外执行 `npm.cmd run test:sdk`：使用已安装的真实 SDK、临时 Agent 配置/工作区和本地模拟模型，验证流式生成、工具调用、扩展弹窗、会话持久化/恢复及释放。不读取个人凭据，也不调用付费模型。常规 `npm test` 默认跳过该集成用例；本次兼容验证版本为 Pi 0.84.4。
