# cpu-power-mode-audit.ps1
# Follow-up: lowering PROCTHROTTLEMIN 100->5 changed NOTHING (idle % Processor
# Performance stayed ~214). So the idle-high-clock comes from elsewhere.
# Prime suspect: the Windows 11 "power mode" overlay - ActiveOverlayAcPowerScheme
# was ded574b5-45a0-4f42-8737-46345c09c238 = "Best performance".
#
# This script (a) dumps the SUB_PROCESSOR settings the active scheme and each
# overlay actually carry, (b) measures idle counters under each overlay, and
# (c) restores the user's original overlay when done.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-power-mode-audit.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$SUB_PROC = '54533251-82be-4824-96c1-47b60b740d00'
$powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$KNOWN = @{
  '893dee8e-2bef-41e0-89c6-b55d0929964c' = 'PROCTHROTTLEMIN (最小处理器状态)'
  'bc5038f7-23e0-4960-96da-33abaf5935ec' = 'PROCTHROTTLEMAX (最大处理器状态)'
  '36687f9e-e3a5-4dbf-b1dc-15eb381c6863' = 'PERFEPP (能源性能偏好/EPP)'
  'be337238-0d82-4146-a960-4f3749d470c7' = 'PERFBOOSTMODE (性能提升模式)'
  '94d3a615-a899-4ac5-ae2b-e4d8f634367f' = 'SYSCOOLPOL (系统散热方式)'
  '0cc5b647-c1df-4637-891a-dec35c318583' = 'CPMINCORES (核心放置最小核心)'
  '45bcc044-d885-43e2-8605-ee0ec6e96b59' = 'PERFBOOSTPOL'
}
function Dump-Proc([string]$guid, [string]$label) {
  $base = Join-Path $powerRoot ($guid + '\' + $SUB_PROC)
  W ('  --- ' + $label + ' [' + $guid + '] ---')
  if (-not (Test-Path $base)) { W '      (no SUB_PROCESSOR key => nothing overridden)'; return }
  $n = 0
  Get-ChildItem -Path $base | ForEach-Object {
    $ac = (Get-ItemProperty -Path $_.PSPath -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
    $nm = $KNOWN[$_.PSChildName]; if (-not $nm) { $nm = '?' }
    W ('      ' + $_.PSChildName + '  AC=' + $ac + '   ' + $nm)
    $n++
  }
  if ($n -eq 0) { W '      (empty)' }
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
  W ('[' + $tag + '] idle: ' + ($line -join '  '))
}
function Get-Overlay() { return (Get-ItemProperty -Path $powerRoot).ActiveOverlayAcPowerScheme }

$orig = Get-Overlay
$scheme = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
W ('active scheme = ' + $scheme)
W ('active overlay = ' + $orig)
W ''
W '== overlaylist =='
foreach ($l in (powercfg /overlaylist)) { W ('  ' + $l) }

W ''
W '== what each scheme/overlay carries under SUB_PROCESSOR =='
Dump-Proc $scheme 'ACTIVE PLAN (高性能)'
Dump-Proc $orig 'ACTIVE OVERLAY (最佳性能?)'
Dump-Proc '961cc777-2547-4f9d-8174-7d86181b8a7a' 'overlay 最佳能效?'
Dump-Proc '00000000-0000-0000-0000-000000000000' 'overlay 平衡?'
Dump-Proc '381b4222-f694-41f0-9685-ff5bb260df2e' 'SCHEME_BALANCED'

W ''
W '===== measurement: with the user''s current overlay ====='
Show-Idle 'orig overlay'
Start-Sleep -Milliseconds 2000
Show-Idle 'orig overlay (2nd)'

$cands = @('00000000-0000-0000-0000-000000000000', '961cc777-2547-4f9d-8174-7d86181b8a7a')
foreach ($c in $cands) {
  W ''
  W ('===== try overlay ' + $c + ' =====')
  powercfg /setactiveoverlay $c
  W ('  rc=' + $LASTEXITCODE + '  now active overlay = ' + (Get-Overlay))
  Start-Sleep -Milliseconds 3000
  Show-Idle ('overlay ' + $c)
  Start-Sleep -Milliseconds 2000
  Show-Idle ('overlay ' + $c + ' (2nd)')
}

W ''
W '===== restore original overlay ====='
powercfg /setactiveoverlay $orig
W ('  rc=' + $LASTEXITCODE + '  now active overlay = ' + (Get-Overlay))
Start-Sleep -Milliseconds 2000
Show-Idle 'restored'
W '# done'
