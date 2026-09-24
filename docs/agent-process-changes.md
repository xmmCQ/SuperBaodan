# Agent 独立进程改造文件清单

以下相对路径仅列本轮相对开始时基线的变化；此前未提交的性能优化已保留。

## 进程与协议

- `app/agent/main.mjs`
- `app/agent/process-host.mjs`
- `app/agent/agent-context.mjs`
- `app/main/agent-process-manager.mjs`
- `app/main/backend-manager.mjs`
- `app/main/config.mjs`
- `app/main/main.mjs`
- `app/main/process-job.mjs`
- `app/main/service-broker.mjs`
- `app/main/service-client.mjs`
- `app/shared/agent-protocol.js`

## 本地业务与归属调整

- `app/services/agent-client.mjs`
- `app/services/main.mjs`
- `app/services/runtime-context.mjs`
- `app/services/workspace-operations.mjs`
- `app/services/event-channel.mjs`
- `app/services/commands/agent.mjs`
- `app/services/commands/index.mjs`
- `app/services/commands/sessions.mjs`
- `app/services/commands/skills.mjs`
- `app/services/commands/system.mjs`
- `app/services/commands/vskills.mjs`
- `app/services/commands/workspaces.mjs`
- `app/services/domain/pi-sdk.mjs`
- `app/services/domain/project-prompt.mjs`
- `app/services/domain/workspace-layout.mjs`
- `app/services/domain/workspace-registry.mjs`
- `app/services/domain/workspace.mjs`

## 助手局部恢复与交互

- `app/renderer/assistant/chat-view.js`
- `app/renderer/assistant/main.js`
- `app/renderer/core/agent-client.js`
- `app/renderer/core/agent-ui.js`
- `app/renderer/core/event-stream.js`
- `app/renderer/home/home-chat.js`
- `app/renderer/home/main.js`
- `app/renderer/ui-dialog.js`
- `app/renderer/workspace-switcher.js`

## 测试与文档

新增隔离测试和进程夹具：

- `test/agent-process.test.mjs`
- `test/agent-contract.test.mjs`
- `test/desktop-agent-supervision.test.mjs`
- `test/desktop-agent-smoke.test.mjs`
- `test/helpers/process-pair.mjs`
- `test/helpers/fake-agent-process.mjs`
- `test/helpers/contract-agent-process.mjs`
- `test/helpers/agent-owner-process.mjs`
- `test/helpers/agent-context.mjs`
- `test/helpers/linked-contexts.mjs`
- `test/helpers/local-agent-stub.mjs`

既有测试按新归属/协议适配，保留原有安全断言：

- `test/app-data-context.test.mjs`
- `test/desktop-backend-manager.test.mjs`
- `test/large-agent-events.test.mjs`
- `test/pi-sdk-api.test.mjs`
- `test/project-prompt.test.mjs`
- `test/review-regressions.test.mjs`
- `test/runtime-turn-files.test.mjs`
- `test/service-client.test.mjs`
- `test/service-process.test.mjs`
- `test/skill-collisions.test.mjs`
- `test/workspace-operation-races.test.mjs`
- `test/helpers/command-http-fixture.mjs`
- `test/helpers/smoke-server.mjs`
- `test/layers.mjs`

架构、验收证据和未覆盖项目见 `docs/architecture.md`。未改版本、未打包、未提交或上传 Git，未升级依赖。
