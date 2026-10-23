# cpu-epp-cleanup.ps1   *** MUST RUN ELEVATED ***
# Retry removing this session's stray PERFEPP override with the *brokered* powercfg
# path (raw registry writes are denied by ACL: the key is owned by SYSTEM and
# Administrators only hold ReadKey). Non-elevated /deletesetting returned
# "你没有执行此操作所需的权限", hence elevation.
$pr = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$sub = '54533251-82be-4824-96c1-47b60b740d00'
$epp = '36687f9e-e3a5-4dbf-b1dc-15eb381c6863'
$plan = 'af77c3cb-cfc8-4516-8e3b-821eb82fd373'
$log = Join-Path $PSScriptRoot 'cpu-epp-cleanup.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$wp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
W ('run at ' + (Get-Date).ToString('s'))
W ('elevated = ' + $wp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
$k = Join-Path $pr ($plan + '\' + $sub + '\' + $epp)
W ('EPP key exists before = ' + (Test-Path $k))
if (Test-Path $k) { W ('  ACSettingIndex before = ' + (Get-ItemProperty -Path $k -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex) }

powercfg /deletesetting $sub $epp
W ('powercfg /deletesetting rc = ' + $LASTEXITCODE)
powercfg /setactive $plan
W ('powercfg /setactive rc = ' + $LASTEXITCODE)

W ('EPP key exists after = ' + (Test-Path $k))
if (Test-Path $k) {
  W ('  ACSettingIndex after = ' + (Get-ItemProperty -Path $k -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex)
} else {
  W '  (override subkey gone => original state restored)'
}
W ('active plan = ' + (Get-ItemProperty -Path $pr).ActivePowerScheme)
W '# done'
