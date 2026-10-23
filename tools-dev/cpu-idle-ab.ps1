# cpu-idle-ab.ps1
# Settle two questions with an alternating test (transient- and load-controlled):
#   Q1  Does the plan actually change the IDLE clock?  (earlier single-shot A/B may
#       have been confounded: the 103% reading came with 2.2% CPU time, the ~215%
#       readings with 6-21%.)
#   Q2  Is EPP (能源性能偏好, on HWP systems the real "how eager to clock" knob)
#       a working lever here?
#
# Windows per window, alternating so drift cannot masquerade as an effect:
#   1 A  高性能 as-is (min=5,max=100)      5 A  高性能 + EPP=100
#   2 B  SCHEME_BALANCED (min=20)          6 B  SCHEME_BALANCED (repeat)
#   3 A  高性能 as-is (repeat)             7 A  高性能 + EPP=50
#   4 B  SCHEME_BALANCED (repeat)          8 A  高性能 restored (EPP removed)
# Each window: 6 s settle, then 3x1 s _Total samples + one per-core sample.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-idle-ab.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$SUB_PROC = '54533251-82be-4824-96c1-47b60b740d00'
$SET_EPP = '36687f9e-e3a5-4dbf-b1dc-15eb381c6863'
$powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$HIGH = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
$BAL = '381b4222-f694-41f0-9685-ff5bb260df2e'
$eppKey = Join-Path $powerRoot ($HIGH + '\' + $SUB_PROC + '\' + $SET_EPP)
$eppPreexisting = Test-Path $eppKey
W ('active scheme = ' + $HIGH + '   balanced = ' + $BAL)
W ('EPP key preexisting in active plan = ' + $eppPreexisting + '  (false => we created it, must remove on restore)')
if ($eppPreexisting) {
  $v = (Get-ItemProperty -Path $eppKey -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
  W ('  preexisting EPP(AC) = ' + $v)
}

function Set-Plan([string]$guid) { powercfg /setactive $guid; W ('  [set plan] ' + $guid + ' rc=' + $LASTEXITCODE) }
function Set-Epp([int]$val) {
  powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR $SET_EPP $val
  $r1 = $LASTEXITCODE
  powercfg /setactive SCHEME_CURRENT
  W ('  [set EPP] ' + $val + ' rc=' + $r1 + '/' + $LASTEXITCODE)
}
function Clear-Epp() {
  if (-not $eppPreexisting) {
    if (Test-Path $eppKey) { Remove-ItemProperty -Path $eppKey -Name ACSettingIndex -ErrorAction SilentlyContinue }
    if (Test-Path $eppKey) {
      $left = Get-Item -Path $eppKey
      if (-not (Get-ItemProperty -Path $eppKey -ErrorAction SilentlyContinue)) { }
      $props = (Get-ItemProperty -Path $eppKey).PSObject.Properties.Name | Where-Object { $_ -like '*SettingIndex' }
      if (-not $props) { Remove-Item -Path $eppKey -Recurse -Force -ErrorAction SilentlyContinue }
    }
    W ('  [clear EPP] key exists now = ' + (Test-Path $eppKey))
  } else { W '  [clear EPP] skipped (was preexisting)' }
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
  W ('  [' + $tag + '] ' + ($line -join '  ') + '   | per-core %Perf median=' + [math]::Round($med, 0) + ' max=' + [math]::Round($mx, 0))
}

try {
  W ''
  W '== 1) A: 高性能 as-is (min=5, max=100) =='
  Measure-Window 'A1'
  W '== 2) B: SCHEME_BALANCED =='
  Set-Plan $BAL; Measure-Window 'B1'
  W '== 3) A again =='
  Set-Plan $HIGH; Measure-Window 'A2'
  W '== 4) B again =='
  Set-Plan $BAL; Measure-Window 'B2'
  W '== 5) A + EPP=100 (max efficiency) =='
  Set-Plan $HIGH; Set-Epp 100; Measure-Window 'A+EPP100'
  W '== 6) B again (repeat) =='
  Set-Plan $BAL; Measure-Window 'B3'
  W '== 7) A + EPP=50 (balanced EPP) =='
  Set-Plan $HIGH; Set-Epp 50; Measure-Window 'A+EPP50'
} finally {
  W ''
  W '== restore =='
  Clear-Epp
  Set-Plan $HIGH
  powercfg /setactive $HIGH
  $now = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
  W ('  now active = ' + $now + '   EPP key exists = ' + (Test-Path $eppKey))
  Measure-Window 'restored'
}
W '# done'
