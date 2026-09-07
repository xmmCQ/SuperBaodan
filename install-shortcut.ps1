$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '超级宝蛋.lnk'
$launcher = Join-Path $root 'launcher.mjs'
$icon = Join-Path $root 'public\baodan.ico'
$node = (Get-Command node.exe -ErrorAction Stop).Source

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $node
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = '超级宝蛋'
$shortcut.Save()

Write-Host "已创建快捷方式：$shortcutPath"
