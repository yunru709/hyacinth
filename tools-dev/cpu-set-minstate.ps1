# cpu-set-minstate.ps1
# Lower PROCTHROTTLEMIN (minimum processor state) on AC for the active plan and
# verify the effect. MAX stays 100% so loaded/turbo performance is untouched.
# The old plan (min=100%) pinned the CPU at maximum performance *while idle*
# (~4.4 GHz per % Processor Performance) - pure heat/fan/battery cost.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-set-minstate.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$NEW_MIN = 5
$node = (Get-Command node).Source
$spin = Join-Path $root 'spin.mjs'
$outDir = Join-Path $root 'minstate-out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$SUB_PROC = '54533251-82be-4824-96c1-47b60b740d00'
$SET_MIN = '893dee8e-2bef-41e0-89c6-b55d0929964c'
$SET_MAX = 'bc5038f7-23e0-4960-96da-33abaf5935ec'
$powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$scheme = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
W ('active scheme = ' + $scheme)

function Get-Setting([string]$guid) {
  $p = Join-Path $powerRoot ($scheme + '\' + $SUB_PROC + '\' + $guid)
  $v = (Get-ItemProperty -Path $p -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
  if ($null -eq $v) { $v = -999 }
  return $v
}
function Show-Plan([string]$tag) {
  W ('[' + $tag + '] registry MIN(AC)=' + (Get-Setting $SET_MIN) + '  MAX(AC)=' + (Get-Setting $SET_MAX))
  W ('[' + $tag + '] powercfg MIN block:')
  foreach ($l in (powercfg /q SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN)) { W ('    ' + $l) }
}
function Show-Idle([string]$tag) {
  $set = @('\Processor Information(_Total)\Processor Frequency',
           '\Processor Information(_Total)\% Processor Performance',
           '\Processor Information(_Total)\% Processor Time')
  $c = Get-Counter -Counter $set -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
  $line = @()
  foreach ($g in ($c.CounterSamples | Group-Object Path)) {
    $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
    $line += (($g.Name -replace '^.*\\', '') + '=' + [math]::Round($avg, 1))
  }
  W ('[' + $tag + '] idle counters: ' + ($line -join '  '))
}
function Run-Spin([string]$tag, [int]$ms) {
  $f = Join-Path $outDir ($tag + '.txt')
  Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $node -ArgumentList @($spin, "$ms") -PassThru -WindowStyle Hidden -RedirectStandardOutput $f
  Start-Sleep -Milliseconds 2500
  $c = Get-Counter -Counter '\Processor Information(_Total)\% Processor Performance' -SampleInterval 1 -MaxSamples 3
  $avg = ($c.CounterSamples | Measure-Object -Property CookedValue -Average).Average
  W ('[' + $tag + '] % Processor Performance under 1-thread load = ' + [math]::Round($avg, 1))
  $p | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
  try { if (-not $p.HasExited) { $p.Kill() } } catch {}
  $t = (Get-Content -LiteralPath $f -Raw).Trim()
  if ($t) { W ('[' + $tag + '] spin iters/s = ' + [int]((ConvertFrom-Json $t).iters / ($ms / 1000.0))) }
}

W ''
W '===== BEFORE ====='
Show-Plan 'before'
Show-Idle 'before'
Run-Spin 'before_1t' 8000

W ''
W '===== APPLY: PROCTHROTTLEMIN(AC) = ' + $NEW_MIN + ' (MAX unchanged) ====='
powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN $NEW_MIN
$rc1 = $LASTEXITCODE
powercfg /setactive SCHEME_CURRENT
$rc2 = $LASTEXITCODE
W ('  rc=' + $rc1 + '/' + $rc2)
Start-Sleep -Milliseconds 4000

W ''
W '===== AFTER ====='
Show-Plan 'after'
Show-Idle 'after (1st)'
Start-Sleep -Milliseconds 3000
Show-Idle 'after (2nd)'
Run-Spin 'after_1t' 8000
Show-Idle 'after idle again'

W ''
W ('# rollback: powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 100 ; powercfg /setactive SCHEME_CURRENT')
W '# done'
