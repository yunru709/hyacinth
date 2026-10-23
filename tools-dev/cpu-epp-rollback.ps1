# cpu-epp-rollback.ps1   *** MUST RUN ELEVATED (HKLM power keys need admin) ***
# Removes the PERFEPP (36687f9e-e3a5-4dbf-b1dc-15eb381c6863) override that this
# session wrote into the user's active power plan
# (HKLM\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\<plan>\<SUB_PROCESSOR>\<EPP>).
# That override did not exist before, so removing it restores the original state.
# Everything is logged so the caller can verify from the log (not from exit codes).
$pr = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$sub = '54533251-82be-4824-96c1-47b60b740d00'
$epp = '36687f9e-e3a5-4dbf-b1dc-15eb381c6863'
$plan = 'af77c3cb-cfc8-4516-8e3b-821eb82fd373'
$log = Join-Path $PSScriptRoot 'cpu-epp-rollback.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$wp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
W ('run at ' + (Get-Date).ToString('s'))
W ('elevated = ' + $wp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

$k = Join-Path $pr ($plan + '\' + $sub + '\' + $epp)
W ('key = ' + $k)
W ('exists before = ' + (Test-Path $k))
if (Test-Path $k) {
  foreach ($n in @('ACSettingIndex', 'DCSettingIndex')) {
    $v = (Get-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue).$n
    W ('  ' + $n + ' = ' + $v)
  }
  foreach ($n in @('ACSettingIndex', 'DCSettingIndex')) {
    try { Remove-ItemProperty -Path $k -Name $n -ErrorAction Stop; W ('  removed ' + $n) }
    catch { W ('  REMOVE ' + $n + ' FAILED: ' + $_.Exception.Message) }
  }
  $left = @()
  try { $left = @((Get-Item -Path $k -ErrorAction Stop).Property) } catch { $left = @('?') }
  W ('  props left = [' + ($left -join ',') + ']')
  if ($left.Count -eq 0) {
    try { Remove-Item -Path $k -Force -ErrorAction Stop; W '  empty key removed' }
    catch { W ('  KEY REMOVE FAILED: ' + $_.Exception.Message) }
  }
}
W ('exists after = ' + (Test-Path $k))
if (Test-Path $k) { W ('  remaining props = [' + (@((Get-Item $k).Property) -join ',') + ']') }

powercfg /setactive $plan
W ('powercfg /setactive ' + $plan + ' rc=' + $LASTEXITCODE)
W ('active plan now = ' + (Get-ItemProperty -Path $pr).ActivePowerScheme)
W '# done'
