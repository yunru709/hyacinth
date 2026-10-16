# 扫描目录下所有 reparse point（符号链接 / Junction），并判定是否指向仓库
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$RepoNeedle = 'Desktop\Agent\hyacinth\node_modules'
)

$hits = New-Object System.Collections.ArrayList
$total = 0

function Scan([string]$dir) {
  $script:total++
  $entries = $null
  try { $entries = [System.IO.Directory]::GetFileSystemEntries($dir) } catch { return }

  foreach ($p in $entries) {
    try {
      $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    } catch { continue }

    # ReparsePoint 属性 = 符号链接 或 Junction
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      $target = $null
      try { $target = $item.Target } catch { }
      $isDir = $item.PSIsContainer
      [void]$hits.Add([pscustomobject]@{
        Path   = $p
        IsDir  = $isDir
        Target = ($target -join ',')
        ToRepo = ($target -join ',') -like "*$RepoNeedle*"
      })
    }

    if ($item.PSIsContainer) { Scan $p }
  }
}

"Scanning $Root ..."
$sw = [Diagnostics.Stopwatch]::StartNew()
Scan $Root
$sw.Stop()

"扫描目录数 = $total"
"耗时 = $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
""
"===== reparse points 总数: $($hits.Count) ====="
if ($hits.Count -gt 0) {
  $hits | Select-Object -First 40 | Format-Table -AutoSize -Wrap
  $repoHits = $hits | Where-Object { $_.ToRepo }
  ""
  "===== 指向仓库的: $($repoHits.Count) ====="
  if ($repoHits.Count -gt 0) { $repoHits | Select-Object -First 40 | Format-Table -AutoSize -Wrap }
} else {
  "NONE - 完全无链接，可跨盘搬运"
}

# 落盘报告：默认写进**仓库内**的 stage\（该目录已 gitignore；无则自动建）
$report = Join-Path $PSScriptRoot 'stage\reparse-report.json'
$reportDir = Split-Path -Parent $report
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Force -Path $reportDir | Out-Null }
$hits | ConvertTo-Json -Depth 4 | Out-File $report -Encoding utf8
"报告 -> $report"
