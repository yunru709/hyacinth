# cpu-plan-load-ab.ps1
# Removes the one confound that made my earlier plan A/B (cpu-idle-ab) unusable:
# system load differed between windows (A: 12.8-19.2% CPU time, B: 7.8-8.3%), so A/B
# differences could not be attributed to the plan.
#
# Here a FIXED 4-thread load runs for the whole test, while the plan is flipped
# A(高性能) -> B(平衡) -> A -> B. With identical load in every window, any remaining
# difference in `Processor Frequency` / `% Processor Performance` is the plan's.
#
# This directly tests the user's report: "Task Manager used to show the real
# frequency" -> if B reports a moving/real value while A stays pinned at 2100, the
# plan (i.e. whatever switched it to 高性能) is the variable.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-plan-load-ab.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$node = (Get-Command node).Source
$spin = Join-Path $root 'spin.mjs'
$out = Join-Path $root 'loadab-out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$pr = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$HIGH = (Get-ItemProperty -Path $pr).ActivePowerScheme
$BAL = '381b4222-f694-41f0-9685-ff5bb260df2e'
W ('plan A (user, 高性能) = ' + $HIGH)
W ('plan B (平衡)          = ' + $BAL)

function Sample([string]$tag) {
  $paths = @('\Processor Information(_Total)\Processor Frequency',
             '\Processor Information(_Total)\% Processor Performance',
             '\Processor Information(_Total)\% Processor Utility',
             '\Processor Information(_Total)\% Processor Time')
  $c = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
  $line = @()
  if ($c) {
    foreach ($g in ($c.CounterSamples | Group-Object Path)) {
      $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
      $line += (($g.Name -replace '^.*\\', '') + '=' + [math]::Round($avg, 1))
    }
  }
  W ('  [' + $tag + '] ' + ($line -join '  '))
}

function Window([string]$planGuid, [string]$tag) {
  powercfg /setactive $planGuid
  $rc = $LASTEXITCODE
  Start-Sleep -Seconds 8              # let PPM settle, load already steady
  W ('== ' + $tag + ' (setactive rc=' + $rc + ') ==')
  Sample ($tag + '-1')
  Start-Sleep -Seconds 5
  Sample ($tag + '-2')
}

$procs = @()
try {
  W ''
  W '=== starting 4-thread fixed load for the whole test ==='
  for ($i = 0; $i -lt 4; $i++) {
    $f = Join-Path $out ('spin_' + $i + '.txt')
    Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
    $procs += (Start-Process -FilePath $node -ArgumentList @($spin, '200000') -PassThru -WindowStyle Hidden -RedirectStandardOutput $f)
  }
  W ('  load pids: ' + (($procs | ForEach-Object { $_.Id }) -join ','))
  Start-Sleep -Seconds 4

  Window $HIGH 'A1 高性能'
  Window $BAL  'B1 平衡'
  Window $HIGH 'A2 高性能'
  Window $BAL  'B2 平衡'
} finally {
  foreach ($p in $procs) { try { if (-not $p.HasExited) { $p.Kill() } } catch {} }
  W ''
  W '=== stop load, restore user plan ==='
  powercfg /setactive $HIGH
  W ('  setactive rc=' + $LASTEXITCODE + '  active = ' + (Get-ItemProperty -Path $pr).ActivePowerScheme)
}
W '# done'
