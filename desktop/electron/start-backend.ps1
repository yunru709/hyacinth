# 启动 staged 后端（Electron 内置 Node），并采集读数
$ErrorActionPreference = 'Continue'
$app  = 'C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\app'
$elec = 'C:\Users\74689\Desktop\Agent\hyacinth-desktop\node_modules\electron\dist\electron.exe'
$log  = 'C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\backend-out.log'
$err  = 'C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\backend-err.log'

Remove-Item $log,$err -Force -ErrorAction SilentlyContinue

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $elec
$psi.Arguments = '"' + $app + '\dist\index.js" webui --port 3130 --provider deepseek --no-auth'
$psi.WorkingDirectory = $app
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$psi.EnvironmentVariables['HYACINTH_NO_OPEN_BROWSER'] = '1'
$psi.EnvironmentVariables['FORCE_COLOR'] = '0'

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$null = $p.Start()
"PID=$($p.Id)"

# 异步读，避免管道缓冲塞死
$so = $p.StandardOutput.ReadToEndAsync()
$se = $p.StandardError.ReadToEndAsync()

# 轮询 health
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3130/api/health' -TimeoutSec 2
    "HEALTH status=$($r.StatusCode) after $([math]::Round(($i+1)*0.5,1))s"
    "HEALTH body=$($r.Content)"
    $ok = $true
    break
  } catch { }
}
if (-not $ok) { "HEALTH FAILED within 30s" }

"PID_STILL_ALIVE=$(-not $p.HasExited)"
if ($p.HasExited) { "EXITCODE=$($p.ExitCode)" }

# 拿输出
if ($so.Wait(3000)) { $so.Result | Out-File $log -Encoding utf8 }
if ($se.Wait(3000)) { $se.Result | Out-File $err -Encoding utf8 }
"--- STDOUT (last 30) ---"
if (Test-Path $log) { Get-Content $log -Tail 30 }
"--- STDERR (last 30) ---"
if (Test-Path $err) { Get-Content $err -Tail 30 }
"PID=$($p.Id) still running; leaving it up for GUI test"
