<#
  dsh web + SSH 隧道：一次执行完成「建隧道 → 起远端 web → 打开页面」。
  幂等：隧道已在且能连通就复用；端口上有失效 ssh 就按端口精确清理。
  隧道用 Start-Process 分离启动，因此关掉本窗口不会断。
  用法：  ./dsh-web-tunnel.ps1            默认端口 3299
          ./dsh-web-tunnel.ps1 -NoOpen  只打印地址，不自动开浏览器
#>
param(
    [int]$Port = 3299,
    [string]$SshHost = 'ayerelysia@frp.volx.top',
    [string]$SshPort = '6020',
    [string]$RemoteScript = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/scripts/dsh-web-start.sh',
    [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$SshExe = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'

function Get-TunnelListener {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

function Test-TunnelAlive {
    if (-not (Get-TunnelListener)) { return $false }
    try {
        Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/') -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop | Out-Null
        return $true
    } catch {
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Clear-StaleTunnel {
    foreach ($procId in (Get-TunnelListener | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'ssh') {
            Write-Host ('  [清理] 端口 ' + $Port + ' 被失效隧道占用，终止 ssh pid=' + $procId)
            Stop-Process -Id $procId -Force
        } else {
            throw ('端口 ' + $Port + ' 被非 ssh 进程占用：' + $p.ProcessName + ' pid=' + $procId + '，请先自行处理')
        }
    }
    Start-Sleep -Milliseconds 900
}

function Start-Tunnel {
    $forward = '-L'
    $spec = $Port.ToString() + ':127.0.0.1:3299'
    Start-Process -FilePath $SshExe -WindowStyle Hidden -ArgumentList @(
        '-N',
        '-o','ServerAliveInterval=30',
        '-o','ServerAliveCountMax=3',
        '-o','ExitOnForwardFailure=yes',
        '-o','StrictHostKeyChecking=no',
        $forward,$spec,
        '-p',$SshPort,$SshHost
    ) | Out-Null
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 1
        if (Get-TunnelListener) { return $true }
    }
    return $false
}

Write-Host '=== 1/3 隧道 ===' -ForegroundColor Cyan
if (Test-TunnelAlive) {
    Write-Host ('  [复用] 127.0.0.1:' + $Port + ' 已通（独立进程，不随本窗口退出）') -ForegroundColor Green
} else {
    if (Get-TunnelListener) { Clear-StaleTunnel }
    Write-Host '  [启动] 建立独立隧道…'
    if (-not (Start-Tunnel)) {
        Write-Host '  [失败] 30 秒内未建立监听：检查网络 / 代理 / frp 服务端' -ForegroundColor Red
        return
    }
    $owner = (Get-TunnelListener | Select-Object -First 1).OwningProcess
    Write-Host ('  [就绪] 隧道 pid=' + $owner) -ForegroundColor Green
}

Write-Host '=== 2/3 远端 dsh web ===' -ForegroundColor Cyan
$out = & $SshExe -p $SshPort $SshHost ('bash ' + $RemoteScript) 2>&1
$out | Where-Object { $_ -notmatch '^\s*http://' } | ForEach-Object { Write-Host ('  ' + $_) }

Write-Host '=== 3/3 打开页面 ===' -ForegroundColor Cyan
$remote = ($out | Select-String -Pattern 'http://[0-9.]+:[0-9]+/\?token=[A-Za-z0-9_-]+' | Select-Object -Last 1).Matches.Value
if (-not $remote) {
    Write-Host '  [失败] 没拿到带 token 的地址，看上面远端输出' -ForegroundColor Red
    return
}
$token = ($remote -split 'token=')[-1]
$url = 'http://127.0.0.1:' + $Port + '/?token=' + $token
Write-Host ('  ' + $url) -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 20 -UseBasicParsing -MaximumRedirection 5 -ErrorAction Stop
    Write-Host ('  [自检] HTTP ' + $r.StatusCode + '，页面正常') -ForegroundColor Green
} catch {
    if ($_.Exception.Response) {
        Write-Host ('  [自检] HTTP ' + [int]$_.Exception.Response.StatusCode + '（token 校验已通过）') -ForegroundColor Green
    } else {
        Write-Host ('  [自检] 请求异常：' + $_.Exception.Message) -ForegroundColor Red
    }
}
if (-not $NoOpen) { Start-Process $url }
Write-Host ''
Write-Host '完成。隧道是分离进程，关掉本窗口也不会断。' -ForegroundColor Green
Write-Host '停止隧道：Get-NetTCPConnection -LocalPort 3299 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }' -ForegroundColor DarkGray
