param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$apps = @(
    @{ Name = '语雀'; Path = 'C:\Users\niuli2288\AppData\Local\Programs\yuque-desktop\语雀.exe'; Processes = @('语雀', 'Yuque') },
    @{ Name = '微信'; Path = 'D:\Program Files\Tencent\Weixin\Weixin.exe'; Processes = @('Weixin') },
    @{ Name = '钉钉'; Path = 'C:\Program Files (x86)\DingDing\DingtalkLauncher.exe'; Processes = @('DingTalk', 'DingtalkLauncher') }
)

$results = foreach ($app in $apps) {
    try {
        $running = $false
        foreach ($processName in $app.Processes) {
            if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
                $running = $true
                break
            }
        }

        if ($running) {
            [PSCustomObject]@{ name = $app.Name; status = 'already_running'; message = '已运行' }
        }
        elseif (-not (Test-Path -LiteralPath $app.Path)) {
            [PSCustomObject]@{ name = $app.Name; status = 'failed'; message = "程序不存在：$($app.Path)" }
        }
        elseif ($DryRun) {
            [PSCustomObject]@{ name = $app.Name; status = 'dry_run'; message = '可启动' }
        }
        else {
            Start-Process -FilePath $app.Path | Out-Null
            [PSCustomObject]@{ name = $app.Name; status = 'started'; message = '已启动' }
        }
    }
    catch {
        [PSCustomObject]@{ name = $app.Name; status = 'failed'; message = $_.Exception.Message }
    }
}

$results | ConvertTo-Json -Compress
