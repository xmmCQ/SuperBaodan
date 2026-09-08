# shell-output-guard

可选的 Pi 终端输出重定向防护扩展，无额外依赖。

## 部署方式

将本目录中的 `index.js` 复制到：

```text
%USERPROFILE%\.pi\agent\extensions\shell-output-guard\index.js
```

使用同一 Pi 用户配置目录的 Pi CLI 和超级宝蛋会自动加载该扩展。本目录仅提供安装源文件，超级宝蛋不会直接从此处加载。

使用自定义 Agent 目录时，将文件安装到该目录下的 `extensions\shell-output-guard\index.js`。禁用扩展时不会加载。

安装或更新后，完整退出并重新打开超级宝蛋；直接使用 Pi CLI 时，可重启或执行 `/reload`。不要同时在多个自动加载位置安装同一扩展。

此扩展配合 Pi 0.84.4 使用。更新 Pi 前建议备份扩展文件；备份应放在扩展自动加载目录之外。

## 产品功能

- 提醒助手区分 Bash、PowerShell 和 CMD 的输出重定向方式。
- 阻止 Bash、PowerShell 直接将输出误写到名为 `nul` 的文件。
- 对直接执行的用户 Bash 命令提供同类拦截。
- 保留 CMD 内部合法的 `nul` 重定向，不拦截普通字符串和注释中的示例。

该扩展不解析所有动态拼接和嵌套脚本，不替代完整的终端安全防护。
