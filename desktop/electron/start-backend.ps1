# 启动 staged 后端并采集读数 —— **开发期辅助**：不起 Electron 窗口，只把后端起起来看它能不能好。
#
# ⚠️ 2026-10-17 修正两处（原先它是按仓库外目录写的，与"GUI 是仓库内的平行 UI"不符）：
#   ① 路径改为**以仓库为基准**（$PSScriptRoot 推导）；
#   ② 后端改用**真 node**。原脚本用 `ELECTRON_RUN_AS_NODE=1 electron.exe …` —— 实测那条路会被
#      commander 拒为 `unknown option '--port'`（真 node 同一命令正常）⇒ 该路已废，不要再用。
param(
  [string]$Stage   = '',
  [string]$NodeExe = 'F:\Node\node.exe',
  [int]$Port       = 3130
)
$ErrorActionPreference = 'Continue'
if (-not $Stage) { $Stage = Join-Path $PSScriptRoot 'stage' }

$app = Join-Path $Stage 'app'
$log = Join-Path $Stage 'backend-out.log'
$err = Join-Path $Stage 'backend-err.log'
$entry = Join-Path $app 'dist\index.js'
if (-not (Test-Path $entry)) { throw "缺少 $entry —— 先跑 node desktop\electron\materialize.mjs" }

Remove-Item $log,$err -Force -ErrorAction SilentlyContinue

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $NodeExe
$psi.Arguments = '"' + $entry + '" webui --port ' + $Port + ' --provider deepseek --no-auth'
$psi.WorkingDirectory = $app
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
# 抑制后端"自动打开系统浏览器"（否则每次启动多弹一个）
$psi.EnvironmentVariables['HYACINTH_NO_OPEN_BROWSER'] = '1'
$psi.EnvironmentVariables['FORCE_COLOR'] = '0'

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$null = $p.Start()
"PID=$($p.Id)"

# 异步读，避免管道缓冲塞死
$so = $p.StandardOutput.ReadToEndAsync()
$se = $p.StandardError.ReadToEndAsync()

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    "HEALTH status=$($r.StatusCode) after $([math]::Round(($i+1)*0.5,1))s"
    "HEALTH body=$($r.Content)"
    $ok = $true
    break
  } catch { }
}
if (-not $ok) { "HEALTH FAILED within 30s" }

"PID_STILL_ALIVE=$(-not $p.HasExited)"
if ($p.HasExited) { "EXITCODE=$($p.ExitCode)" }
if ($so.Wait(3000)) { $so.Result | Out-File $log -Encoding utf8 }
if ($se.Wait(3000)) { $se.Result | Out-File $err -Encoding utf8 }
"--- STDERR (last 20) ---"
if (Test-Path $err) { Get-Content $err -Tail 20 }
"（开发期后端起在 $Port；测完自行 Stop-Process -Id $($p.Id)）"
