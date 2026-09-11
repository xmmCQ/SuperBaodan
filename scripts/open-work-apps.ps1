param([switch]$DryRun, [string]$AppsBase64, [switch]$ReadAppsFromStdin)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if ($ReadAppsFromStdin) { $AppsBase64 = [Console]::In.ReadToEnd() }
if ($AppsBase64) {
    $apps = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AppsBase64)) | ConvertFrom-Json
} else {
    $file = Join-Path $PSScriptRoot '..\data\work-apps.json'
    if (-not (Test-Path -LiteralPath $file)) { throw '请先在工作台中保存软件配置，或通过工作台启动。' }
    $apps = @((Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).apps | Where-Object { $_.enabled })
}
$results = foreach ($app in $apps) {
    try {
        if (-not [System.IO.Path]::IsPathRooted($app.path) -or [System.IO.Path]::GetExtension($app.path) -notin @('.exe', '.lnk')) { throw '仅支持程序或快捷方式完整路径' }
        if (-not (Test-Path -LiteralPath $app.path -PathType Leaf)) { throw "程序不存在：$($app.path)" }
        $target = $app.path
        if ([System.IO.Path]::GetExtension($target) -eq '.lnk') {
            $shell = New-Object -ComObject WScript.Shell
            try { $target = $shell.CreateShortcut($app.path).TargetPath }
            finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
        }
        $running = $false
        foreach ($processName in @($app.processes)) {
            if ($processName -and (Get-Process -Name $processName -ErrorAction SilentlyContinue)) { $running = $true; break }
        }
        if (-not $running -and $target) {
            $name = [System.IO.Path]::GetFileNameWithoutExtension($target)
            foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
                if ($process.Path -and $process.Path -ieq $target) { $running = $true; break }
            }
        }
        if ($running) { $status = 'already_running'; $message = '已运行' }
        elseif ($DryRun) { $status = 'dry_run'; $message = '可启动' }
        else { Start-Process -FilePath $app.path | Out-Null; $status = 'started'; $message = '已发送启动请求' }
        [PSCustomObject]@{ name = $app.name; status = $status; message = $message }
    } catch {
        [PSCustomObject]@{ name = $app.name; status = 'failed'; message = $_.Exception.Message }
    }
}
ConvertTo-Json -InputObject @($results) -Compress
