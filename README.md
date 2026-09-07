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
       │ 严格 JSONL RPC
       ▼
Windows Pi：pi --mode rpc
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
- 首页每日记录：按日期维护多条会议纪要或工作记录，支持 Markdown、日历标记、历史搜索及交给宝蛋整理
- 内部工作待办和每日记录的版本冲突校验
- 写入前备份，最多 30 份
- 一键打开语雀、微信和钉钉
- 原宝蛋视觉样式

自研 Windows Pi 助手当前支持：

- Pi JSONL RPC 运行时
- REST 命令与 SSE 实时事件
- 首页工作助手可原地流式对话，不再强制跳转；模型、账号、思考等级与展开助手共用
- 首页可新建、切换、重命名和删除历史会话，运行中可直接停止
- 首页 VSkill：配置“名称 + 固定文字 Prompt”，在输入框上方一键发送；首次提供“本周总结”和“下周工作”两个默认项
- 三栏助手工作区：左侧会话、中间聊天、右侧文件；右栏默认折叠，可按需打开
- 安全多工作区：可添加、搜索、切换、重命名和移除本机目录；首页与展开助手共享当前工作区，每个工作区独立恢复最后会话
- 历史会话按工作区隔离，支持搜索、Pi 原生会话重命名和首条用户消息自动标题
- 首页与展开助手安全渲染 Markdown，支持标题、列表、表格、引用、链接和可复制代码块；事件断线时自动同步最终消息
- 流式文本、思考过程、工具调用及工具状态
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
- 停止、上下文压缩、会话统计
- Skill 管理：按项目/全局/只读来源分组查看，支持 skills.sh 搜索、安装、更新、卸载、自动调用显隐，以及本地自定义 Skill 的创建、结构化/原始 Markdown 编辑和删除
- Prompt Templates、扩展 Slash Commands
- 扩展 confirm/select/input/editor 交互
- Windows PowerShell 及 Pi 内置文件工具
- Pi 空闲 10 分钟自动休眠，下次对话自动恢复原会话

## 运行与退出机制

- 打开工作台首页时自动启动 Windows Pi。
- 对话、工具、压缩或重试期间不会自动关闭 Pi。
- 最后一次 Pi 活动 10 分钟后，仅关闭 Pi RPC；工作台 Node 服务继续运行。
- 健康检查和 SSE 心跳不计为 Pi 活动，不会阻止休眠。
- Pi 休眠后再次发送消息或打开助手，会自动启动并恢复当前会话。
- “退出工作台”按钮同时关闭 Pi 和 Node 服务。
- 可通过 `SUPER_BAODAN_PI_IDLE_MS` 调整空闲时间；默认值为 `600000`。

## 目录与数据

```text
D:\Program Files\SuperBaodan
├─ launcher.mjs            Windows Node 原生启动器
├─ server.mjs              服务启动与优雅退出入口
├─ server\app.mjs          HTTP应用装配、维护锁和静态文件回退
├─ server\router.mjs       无第三方依赖的轻量路由表
├─ server\runtime-context.mjs  Pi、工作区、SSE和写入队列运行时上下文
├─ server\routes           Agent、会话、认证、模型、Skill、工作区、待办和每日记录路由
├─ lib\pi-rpc.mjs          Windows Pi RPC 管理器
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
├─ test\helpers            可控Pi子进程、临时项目、Edge CDP和冒烟服务
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
node --check lib\pi-rpc.mjs
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
node --check lib/pi-rpc.mjs
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
