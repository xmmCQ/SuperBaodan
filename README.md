# 超级宝蛋

面向个人工作的 Windows 本地工作台，集成日历、待办、每日记录与智能助手。

## 部署方式

### 1. 准备运行环境

- Windows 系统及浏览器。
- Windows Node.js 22.19 或以上版本，确保 `node.exe` 和 `npm.cmd` 可用。
- Windows Pi 0.84.4。

安装 Pi：

```powershell
npm.cmd install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
```

超级宝蛋不需要 WSL，也不需要在项目目录执行 `npm install`。

### 2. 获取并启动

下载仓库源码，或使用 Git 克隆到本机目录。以下以 `D:\Program Files\SuperBaodan` 为例：

```powershell
git clone https://github.com/xmmCQ/SuperBaodan.git 'D:\Program Files\SuperBaodan'
cd 'D:\Program Files\SuperBaodan'
node launcher.mjs
```

私有仓库需要先取得访问权限并完成 Git 认证。若通过下载源码部署，进入解压后的项目目录执行 `node launcher.mjs` 即可。

启动器会按需启动服务并打开浏览器，默认访问地址：

```text
http://127.0.0.1:3211
```

如需桌面快捷方式，执行一次：

```powershell
powershell -ExecutionPolicy Bypass -File 'D:\Program Files\SuperBaodan\install-shortcut.ps1'
```

安装在其他位置时，将上述路径替换为实际目录。日常使用直接打开快捷方式，无需再次执行安装命令。

### 3. 首次配置

1. 在助手设置中登录支持的账号，或配置供应商 API Key。
2. 选择模型及思考等级；也可添加自定义供应商和模型。
3. 添加需要使用的本机工作区目录。
4. 按需配置 Skill 和首页固定提示词。

Pi 默认配置目录为 `%USERPROFILE%\.pi\agent`，账号、模型和默认设置可与使用同一目录的 Pi 共用。请勿将个人凭据提交到仓库。

全局 Skill 默认放在 `%USERPROFILE%\.pi\agent\skills`，项目 Skill 放在对应工作区的 `.pi\skills`。如需终端输出重定向防护，可按 [shell-output-guard 部署说明](extras/pi-extensions/shell-output-guard/README.md) 安装可选扩展。

### 4. 本地数据与更新

- 工作待办：`data\work-todo.md`。
- 每日记录：`data\daily-records.json`。
- 首页固定提示词：`data\vskills.json`。
- 对话会话：`data\sessions`。
- 本地备份：`data\backups`。
- 默认工作区：`workspace`。

以上路径均相对于项目目录。待办和每日记录由各工作区共享，对话历史按工作区区分。仓库不包含个人数据、会话和工作区材料，迁移电脑时需要单独备份并迁移这些内容，以及需要保留的 Pi 用户配置。

更新前通过页面“退出工作台”关闭服务，再更新源码并重新打开。Git 部署且本地没有待提交修改时，可执行：

```powershell
cd 'D:\Program Files\SuperBaodan'
git switch main
git pull --ff-only origin main
node launcher.mjs
```

可通过环境变量 `SUPER_BAODAN_PORT` 调整端口，默认 `3211`；通过 `SUPER_BAODAN_PI_IDLE_MS` 调整助手空闲休眠时间，默认 `600000` 毫秒（10 分钟）。助手休眠后再次使用会自动恢复，工作台页面仍可使用。启动失败时可查看 `data\server-error.log`。

## 产品功能

### 工作日历与待办

- 查看工作日历和当日安排；通过数量提示打开遗留工作、持续工作列表。
- 新增、编辑、完成和删除待办，支持多行事项内容、计划日期、截止日期与周期事项。
- 拖动待办调整日期，拖动当日卡片调整显示顺序。
- 显示中国大陆节假日和调休标识，支持缓存查看；数据来自第三方整理，仅供日程参考，不代表单位排班。
- 一键打开本机已安装且路径已配置的语雀、微信和钉钉。

### 每日记录

- 按日期维护多条会议纪要或工作记录，支持 Markdown。
- 通过日历标记和历史搜索查找记录。
- 调整当日记录顺序，将选中的记录交给宝蛋整理。
- 本地写入前备份，并提示同时修改导致的版本冲突。

### 智能对话

- 首页直接对话，也可展开完整助手；两处共用模型、账号和思考等级。
- 流式显示回答，支持 Markdown、表格、代码块和图片输入。
- 新建、切换、重命名、删除会话，搜索历史标题及对话正文。
- 复制整条回复、复制代码块、引用选中文字在当前对话追问。
- 使用对话目录定位提问和回复标题，快速回到最新消息。
- 折叠查看思考及工具执行过程，区分执行中、重试、停止、失败和完成状态。
- 支持停止任务、压缩上下文，以及在当前任务完成后处理追加消息。
- 连接中断后自动尝试恢复对话显示；助手空闲时休眠，再次使用时恢复会话。

### 工作区与文件

- 添加、搜索、切换、重命名和移除本机工作区，每个工作区恢复各自的最后会话。
- 浏览文件树、搜索文件名、上传文件，并选择同名文件覆盖或跳过。
- 预览文本、Markdown、代码、图片和 PDF。
- 使用文件标签切换已打开文件，保留各文件的阅读位置。
- 拖动调整会话栏和文件面板宽度，放大文件预览或折叠文件树。
- 输入 `@文件名` 搜索并引用当前工作区文件。
- 查看本轮涉及的文件及已确认修改的文件。

### 模型、Skill 与个性化

- 搜索和选择模型，按供应商分组，设置默认模型与思考等级。
- 支持 ChatGPT Plus/Pro（Codex）等 OAuth 登录，以及供应商 API Key 配置。
- 添加和管理自定义供应商、模型参数及可见模型范围。
- 按项目、全局和只读来源查看 Skill；支持搜索、安装、更新、卸载及自动调用显隐。
- 创建、编辑和删除本地自定义 Skill。
- 使用 Prompt Templates、扩展快捷命令，以及确认、选择、输入和编辑弹窗。
- 首页 VSkill 支持配置固定提示词，一键发起常用任务。
- 调整聊天字号和正文宽度，在本机浏览器保存阅读偏好。
