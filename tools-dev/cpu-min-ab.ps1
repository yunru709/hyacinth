# cpu-min-ab.ps1
# One controlled single-variable test, the last open question:
# the user's plan and SCHEME_BALANCED differ ONLY in PROCTHROTTLEMIN (5 vs 20) -
# every other processor setting is identical (see cpu-plan-diff.log). Earlier I saw
# A (2100 pinned, ~213% IdlePerf) vs B (field moving 1983-2064, ~184%) and blamed
# load. So flip ONLY MIN, alternating, and see whether the frequency field and the
# ratio counter flip with it:
#   MIN=5 -> MIN=20 -> MIN=5 -> MIN=20
# Each window: 6 s settle, 3x1 s _Total samples + one per-core sample.
# Ends by restoring the currently chosen state (MIN=5, the user-approved value).
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-min-ab.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$pr = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$sub = '54533251-82be-4824-96c1-47b60b740d00'
$MIN = '893dee8e-2bef-41e0-89c6-b55d0929964c'
$plan = (Get-ItemProperty -Path $pr).ActivePowerScheme
W ('active plan = ' + $plan)

function Set-Min([int]$v) {
  powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN $v
  $r1 = $LASTEXITCODE
  powercfg /setactive SCHEME_CURRENT
  $r2 = $LASTEXITCODE
  $k = Join-Path $pr ($plan + '\' + $sub + '\' + $MIN)
  $rb = (Get-ItemProperty -Path $k -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
  W ('  [set MIN] ' + $v + ' rc=' + $r1 + '/' + $r2 + ' readback=' + $rb)
}
function Measure-Window([string]$tag) {
  Start-Sleep -Seconds 6
  $set = @('\Processor Information(_Total)\Processor Frequency',
           '\Processor Information(_Total)\% Processor Performance',
           '\Processor Information(_Total)\% Processor Time')
  $c = Get-Counter -Counter $set -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
  $line = @()
  foreach ($g in ($c.CounterSamples | Group-Object Path)) {
    $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
    $line += (($g.Name -replace '^.*\\', '') + '=' + [math]::Round($avg, 1))
  }
  $pc = Get-Counter -Counter '\Processor Information(*)\% Processor Performance' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
  $vals = @($pc.CounterSamples | Where-Object { $_.InstanceName -notlike '*_total*' } | Select-Object -ExpandProperty CookedValue | Sort-Object)
  $med = 0; $mx = 0
  if ($vals.Count -gt 0) { $med = $vals[[int]($vals.Count / 2)]; $mx = $vals[$vals.Count - 1] }
  W ('  [' + $tag + '] ' + ($line -join '  ') + '  | per-core med=' + [math]::Round($med, 0) + ' max=' + [math]::Round($mx, 0))
}

try {
  W '== window 1: MIN=5 =='
  Set-Min 5;  Measure-Window 'MIN5-a'
  W '== window 2: MIN=20 =='
  Set-Min 20; Measure-Window 'MIN20-a'
  W '== window 3: MIN=5 =='
  Set-Min 5;  Measure-Window 'MIN5-b'
  W '== window 4: MIN=20 =='
  Set-Min 20; Measure-Window 'MIN20-b'
} finally {
  W '== restore MIN=5 (the user-approved value) =='
  Set-Min 5
  Measure-Window 'restored MIN5'
}
W '# done'
