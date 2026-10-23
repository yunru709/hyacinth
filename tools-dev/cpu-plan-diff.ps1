# cpu-plan-diff.ps1
# 1) Verify/repair the EPP value this session created in the user's active plan
#    (the plan originally had no EPP; leaving a stray 50 there would be an
#    unintended config change).
# 2) Diff the *effective* settings of the user's plan vs SCHEME_BALANCED, to find
#    which setting actually explains the reproducible A/B difference
#    (idle %Perf ~213% + freq field pinned 2100  vs  ~184% + field moving 1983-2064).
#
# Parsing note: powercfg output is localized (Chinese), so everything here is
# parsed from ASCII-only anchors (36-char GUIDs and 0x........ values). Per block
# (blank-line separated): the LAST GUID is the setting GUID, and the AC index is
# the second-to-last 0x value (the DC index is the last one).
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-plan-diff.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$SUB_PROC = '54533251-82be-4824-96c1-47b60b740d00'
$SET_EPP = '36687f9e-e3a5-4dbf-b1dc-15eb381c6863'
$KNOWN = @{
  '893dee8e-2bef-41e0-89c6-b55d0929964c' = 'PROCTHROTTLEMIN 最小处理器状态'
  'bc5038f7-23e0-4960-96da-33abaf5935ec' = 'PROCTHROTTLEMAX 最大处理器状态'
  '36687f9e-e3a5-4dbf-b1dc-15eb381c6863' = 'PERFEPP 能源性能偏好'
  'be337238-0d82-4146-a960-4f3749d470c7' = 'PERFBOOSTMODE 性能提升模式'
  '94d3a615-a899-4ac5-ae2b-e4d8f634367f' = 'SYSCOOLPOL 系统散热方式'
  '0cc5b647-c1df-4637-891a-dec35c318583' = 'CPMINCORES 核心放置最小核心'
  '4b92d758-5a24-4851-a470-815d78aee119' = 'LATENCYHINTUNPARK'
  '7b224883-b3cc-4d79-819f-8374152cbe7c' = 'LATENCYHINT'
  '45bcc044-d885-43e2-8605-ee0ec6e96b59' = 'PERFBOOSTPOL'
  '4f971e89-eebd-4455-a8de-9e59040e7347' = 'SUB_BUTTONS?'
}

$HIGH = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
$BAL = '381b4222-f694-41f0-9685-ff5bb260df2e'

W '== 1) EPP state in the active plan (this session created it) =='
$eppKey = Join-Path $powerRoot ($HIGH + '\' + $SUB_PROC + '\' + $SET_EPP)
W ('  EPP key exists = ' + (Test-Path $eppKey))
if (Test-Path $eppKey) {
  $p = Get-ItemProperty -Path $eppKey -ErrorAction SilentlyContinue
  W ('  props: ' + (($p.PSObject.Properties.Name | Where-Object { $_ -notlike 'PS*' }) -join ', '))
  foreach ($n in @('ACSettingIndex', 'DCSettingIndex')) {
    $v = (Get-ItemProperty -Path $eppKey -Name $n -ErrorAction SilentlyContinue).$n
    W ('    ' + $n + ' = ' + $v)
  }
  foreach ($n in @('ACSettingIndex', 'DCSettingIndex')) {
    if ($null -ne (Get-ItemProperty -Path $eppKey -Name $n -ErrorAction SilentlyContinue).$n) {
      Remove-ItemProperty -Path $eppKey -Name $n -ErrorAction SilentlyContinue
      W ('    REMOVED ' + $n)
    }
  }
  $left = @((Get-Item -Path $eppKey).Property)
  if ($left.Count -eq 0) { Remove-Item -Path $eppKey -Force; W '    removed now-empty EPP key' }
  else { W ('    remaining props: ' + ($left -join ',')) }
  powercfg /setactive SCHEME_CURRENT | Out-Null
  W ('  after cleanup: key exists = ' + (Test-Path $eppKey))
}

W ''
W '== 2) schemes available =='
foreach ($l in (powercfg /L)) { W ('  ' + $l) }

function Get-Eff([string]$scheme) {
  $lines = @(powercfg /q $scheme)
  $blocks = @(); $cur = @()
  foreach ($l in $lines) {
    if ($l.Trim().Length -eq 0) { if ($cur.Count -gt 0) { $blocks += , $cur; $cur = @() } }
    else { $cur += $l }
  }
  if ($cur.Count -gt 0) { $blocks += , $cur }
  $res = @{}
  foreach ($b in $blocks) {
    $txt = ($b -join "`n")
    $guids = [regex]::Matches($txt, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
    $vals = [regex]::Matches($txt, '0x([0-9a-fA-F]{8})')
    if ($guids.Count -eq 0 -or $vals.Count -lt 2) { continue }
    $g = $guids[$guids.Count - 1].Value.ToLower()
    $ac = $vals[$vals.Count - 2].Groups[1].Value
    $res[$g] = [Convert]::ToInt32($ac, 16)
  }
  return $res
}

$a = Get-Eff $HIGH
$b = Get-Eff $BAL
W ''
W ('== 3) effective-setting counts: active plan=' + $a.Count + '  balanced=' + $b.Count + ' ==')
$keys = @($a.Keys + $b.Keys | Sort-Object -Unique)
W ''
W '== 4) DIFF (only settings whose effective AC value differs) =='
W ('  {0,-40} {1,-34} {2,8} {3,8}' -f 'setting GUID', 'name', 'active', 'balanced')
$nDiff = 0
foreach ($k in $keys) {
  $va = $a[$k]; $vb = $b[$k]
  $sa = if ($null -eq $va) { 'absent' } else { $va }
  $sb = if ($null -eq $vb) { 'absent' } else { $vb }
  if ($sa -ne $sb) {
    $nm = $KNOWN[$k]; if (-not $nm) { $nm = '(unknown)' }
    W ('  {0,-40} {1,-34} {2,8} {3,8}' -f $k, $nm, $sa, $sb)
    $nDiff++
  }
}
W ('  total differing settings: ' + $nDiff)
W '# done'
