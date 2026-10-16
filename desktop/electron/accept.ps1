# ============================================================
# 最终验收 v2 —— 彻底清场 + 单一实例 + 完整证据链
# ============================================================
# 修正 v1 的两个取证缺陷：
#   1. v1 未彻底清场 ⇒ 新实例复用了旧实例的后端，"后端属于本包"不纯。
#      这里先杀掉所有 Hyacinth.exe 与包内 node.exe，确认端口空，再启动。
#   2. v1 在 t=+2s 查监听者 ⇒ 撞上后端启动瞬时窗口。
#      这里等 health 通过后再等 3s，并重试监听者查询。
param(
  [string]$Root = 'F:\Hyacinth-Electron',
  [int]$Port = 3130,
  [int]$DbgPort = 9222
)
$ErrorActionPreference = 'Continue'
$logD = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logD | Out-Null
$report = Join-Path $logD 'FINAL-ACCEPTANCE.txt'
Remove-Item $report -Force -ErrorAction SilentlyContinue
function Say($s) { $s | Tee-Object -FilePath $report -Append | Out-Host }

Say "########## HYACINTH ELECTRON 跨盘验收 (v2) ##########"
Say "时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "包根: $Root"
$exe = Join-Path $Root 'Hyacinth.exe'
Say "exe : $exe"
Say "exe size: $((Get-Item $exe).Length) bytes"
Say "version file: $(Get-Content (Join-Path $Root 'version') -Raw)"

# ── 1. 彻底清场 ──
Say ""
Say "=== [1] 彻底清场 ==="
Get-Process -Name 'Hyacinth' -ErrorAction SilentlyContinue | ForEach-Object { Say "  kill Hyacinth PID=$($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
# 杀所有**包内** node.exe（不碰用户 TUI 用的 F:\Node\node.exe）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$Root*" } | ForEach-Object {
  Say "  kill pkg node PID=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
$leftover = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
Say "  清场后 3130 listener: $(if ($leftover) { $leftover.OwningProcess } else { '无' })"
Say "  清场后 Hyacinth 进程: $((Get-Process -Name Hyacinth -ErrorAction SilentlyContinue | Measure-Object).Count)"

# ── 2. 启动（WMI，脱离本进程树）──
Say ""
Say "=== [2] 启动（Invoke-CimMethod Win32_Process Create）==="
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"' + $exe + '" --remote-debugging-port=' + $DbgPort
  CurrentDirectory = $Root
}
Say "  ReturnValue=$($res.ReturnValue) PID=$($res.ProcessId)"
if ($res.ReturnValue -ne 0) { Say "启动失败，终止"; exit 1 }

# ── 3. health ──
Say ""
Say "=== [3] 后端就绪探测 ==="
$health = $null
for ($i=0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    $health = $r
    Say "  t=$([math]::Round(($i+1)*0.5,1))s  HTTP $($r.StatusCode)  $($r.Content)"
    break
  } catch { }
}
if (-not $health) { Say "  !! 60s 内未就绪" }

# 等后端稳定
Start-Sleep -Seconds 4

# ── 4. 监听者归属（重试）──
Say ""
Say "=== [4] 3130 监听者归属（决定性）==="
$found = $false
foreach ($try in 1..10) {
  $c = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
  if ($c) {
    foreach ($x in $c) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($x.OwningProcess)"
      $inPkg = $p.ExecutablePath -like "$Root*"
      Say "  PID=$($x.OwningProcess)  IN_PACKAGE=$inPkg"
      Say "    exe = $($p.ExecutablePath)"
      Say "    cmd = $($p.CommandLine)"
      Say "    ppid= $($p.ParentProcessId)"
      # 父链向上追
      $ppid = $p.ParentProcessId
      for ($d=0; $d -lt 4 -and $ppid -gt 0; $d++) {
        $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction SilentlyContinue
        if (-not $pp) { break }
        Say "      ^ancestor[$d] PID=$ppid exe=$($pp.ExecutablePath)"
        $ppid = $pp.ParentProcessId
      }
    }
    $found = $true
    break
  }
  Start-Sleep -Milliseconds 700
}
if (-not $found) { Say "  !! 未查到 Listen 记录（health 却通过）" }

# ── 5. Electron 主进程与窗口 ──
Say ""
Say "=== [5] Electron 宿主 + 窗口 ==="
Get-CimInstance Win32_Process -Filter "Name='Hyacinth.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
  Say "  MAIN PID=$($_.ProcessId) exe=$($_.ExecutablePath)"
  Say "       cmd=$($_.CommandLine)"
}
$w = Get-Process -Name 'Hyacinth' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($x in $w) { Say "  窗口 PID=$($x.Id) title='$($x.MainWindowTitle)' hwnd=$($x.MainWindowHandle)" }
if (-not $w) { Say "  !! 无可见主窗口" }

# ── 6. CDP（best-effort）──
Say ""
Say "=== [6] CDP :$DbgPort ==="
$cdp = $false
foreach ($try in 1..8) {
  try {
    $j = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$DbgPort/json/list" -TimeoutSec 3).Content
    Say "  $j"
    $cdp = $true
    break
  } catch { Start-Sleep -Milliseconds 800 }
}
if (-not $cdp) { Say "  不可达（不影响交付；产品功能不依赖 CDP）" }

# ── 7. 截图 ──
Say ""
Say "=== [7] 原生窗口截图 ==="
$shot = Join-Path $logD 'FINAL-window.png'
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\74689\Desktop\Agent\hyacinth\tools-dev\gui\shot-window.ps1' -Proc 'Hyacinth' -Out $shot 2>&1 | ForEach-Object { Say "  $_" }
if (Test-Path $shot) { Say "  文件: $shot ($((Get-Item $shot).Length) bytes)" }

Say ""
Say "########## 验收结束 ##########"
Say "报告: $report"
