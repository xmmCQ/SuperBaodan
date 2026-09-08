# shell-output-guard

独立 Pi 扩展，无额外依赖，不引用超级宝蛋代码。此目录保留源码备份；超级宝蛋运行时不从这里注册扩展。

## 安装位置

复制 `index.js` 到用户目录：

```text
C:\Users\niuli2288\.pi\agent\extensions\shell-output-guard\index.js
```

Pi CLI 和使用该 Agent 配置目录的 SDK 会自动发现它。使用其他 Agent 目录或禁用扩展时不会加载。

## Hook

- `before_agent_start`：补充 Bash、PowerShell、CMD 重定向规则。
- `tool_call`：阻止 Bash/PowerShell 直接把输出写入字面量 `nul` 路径。
- `user_bash`：通过替代执行结果阻止用户 Bash 命令，不实际运行原命令。

不匹配普通引号字符串/注释里的示例，也不拦截 `cmd.exe /c "…2>nul"` 内部的合法 CMD 写法。不解析动态拼接或任意嵌套脚本，不是安全沙箱。

## 更新和备份

正常更新 Pi 安装包不会覆盖用户扩展；如果 Pi 更改 Hook API，需要检查兼容性。

当前使用的 Pi 版本：0.84.4。迁移时另存备份到 `C:\Users\niuli2288\.pi\agent\extension-backups\`，该目录不参与扩展自动发现。

安装或更新后，超级宝蛋需完整重启；直接使用 Pi CLI 时可重启或执行 `/reload`。不要同时在超级宝蛋里内置注册同一扩展。
