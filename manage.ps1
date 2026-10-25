# Agent 统筹面板 启动/停止/状态
param([ValidateSet('start','stop','status','restart')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 4590
$Url = "http://127.0.0.1:$Port"
$PidFile = Join-Path $Here 'logs\panel.pid'
New-Item -ItemType Directory -Force -Path (Join-Path $Here 'logs') | Out-Null

function Test-Up { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$Url/api/state").StatusCode -eq 200 } catch { $false } }

function Start-Panel {
  if (Test-Up) { Write-Host "面板已在运行：$Url"; Start-Process $Url; return }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw '找不到 node，请先安装 Node.js 22+' }
  $p = Start-Process -FilePath $node -ArgumentList "`"$Here\server.mjs`"" -WorkingDirectory $Here -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Here 'logs\panel.log') -RedirectStandardError (Join-Path $Here 'logs\panel.err.log') -PassThru
  Set-Content -Path $PidFile -Value $p.Id
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (Test-Up) { Write-Host "面板已启动：$Url（PID $($p.Id)）"; Start-Process $Url; return } }
  throw "启动失败，看 logs\panel.err.log"
}

function Stop-Panel {
  if (Test-Path $PidFile) {
    $id = Get-Content $PidFile
    & taskkill /PID $id /T /F 2>$null | Out-Null
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
  # 兜底：按端口找
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) { & taskkill /PID $c.OwningProcess /T /F 2>$null | Out-Null }
  Write-Host '面板已停止'
}

switch ($Action) {
  'start'   { Start-Panel }
  'stop'    { Stop-Panel }
  'restart' { Stop-Panel; Start-Sleep 1; Start-Panel }
  'status'  { if (Test-Up) { Write-Host "运行中：$Url" } else { Write-Host '未运行' } }
}
