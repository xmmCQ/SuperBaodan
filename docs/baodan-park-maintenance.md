# BaodanPark 布局与迁移维护

## 路径职责

工作区身份、SDK cwd、会话归属和默认交付目录仍是用户选择的 A。统一路径定义在 `app/services/domain/workspace-layout.mjs`。

- `BaodanPark/AGENTS.md`：宝蛋项目提示词。
- `BaodanPark/.pi/skills`：宝蛋项目技能。
- `BaodanPark/tmp/<安全会话ID>/scripts`、`intermediate`：过程文件。
- `BaodanPark/cache/legacy`：迁入的历史缓存，不默认扫描其内容。

原项目规则和设置继续读取；原项目技能标为只读来源。技能列表和 SDK 使用同一组额外资源路径，重复技能依据 SDK 诊断展示，不自行规定优先级。

## 设置兼容边界

用户项目设置来自 A/.pi/settings.json；新增项目设置写入 Park。不同来源存在同字段不同值时明确拒绝，不覆盖其中任意一份。Park 内的包和资源列表设置暂不自动合并，需先评估路径及冲突；普通模型偏好仍保存到应用数据目录。

## 迁移

迁移工具不自动查找或删除用户文件。调用 `scripts/migrate-baodan-park.mjs` 的 `createMigration` 时必须传入明确的源/目标清单以及位于应用数据目录的备份位置。源文件、大小、SHA256、目标及状态保存在备份内的 `migration.json`。

1. 保存草稿、等待任务结束并退出应用。
2. 生成清单与备份，再调用 `stageMigration`；源文件此时仍保留。
3. 使用 `verify-park-migration.mjs` 校验 SDK 和历史会话副本，不调用模型；校验通过才提交并移除原文件。
4. 检查保护文件哈希、工作区 ID、路径及两个工作区各自状态。

中断后使用同一份清单续跑，不能新建第二份清单接管已有 Park：

```text
node scripts/migrate-baodan-park.mjs stage <migration.json>
node scripts/verify-park-migration.mjs <migration.json> <原sessions目录>
```

回滚前退出应用：

```text
node scripts/migrate-baodan-park.mjs rollback <migration.json>
```

回滚拒绝覆盖迁移后用户修改过的源或目标，只恢复清单中的文件。回滚后保留明确的 `rolled-back` 标记并阻止普通打开；需要人工核对布局和代码版本后恢复使用，不能删除标记来绕过校验。

## 验证边界

隔离测试覆盖目录冲突、链接、版本、幂等、SDK 资源加载、会话更换、迁移内容校验、源文件并发变更与回滚冲突。Windows 测试可使用真实工作区路径和会话副本，但使用隔离应用配置，避免改写原聊天和模型设置。

目录规则不是 Shell 安全沙箱。没有付费模型调用的验收不能证明所有模型都会遵守过程目录约定。OneDrive 离线、同步竞争和各类 ACL 权限组合仍需在具体环境复验；读写失败必须保留错误和备份，不能将失败内容当作空文件。
