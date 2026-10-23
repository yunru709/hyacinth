# cpu-recheck.ps1 —— 快速复查「TM 速度恒为标称 2100」症状是否还在 + 系统/我的改动现状（只读，不改任何设置）
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'cpu-recheck.log'
Set-Content -LiteralPath $log -Value ('# run ' + (Get-Date).ToString('s')) -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

W '== OS / build =='
$os = Get-CimInstance Win32_OperatingSystem
W ('  ' + $os.Caption + '   build=' + $os.BuildNumber + '   boot=' + $os.LastBootUpTime)
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
W ('  UBR=' + $cv.UBR + '  DisplayVersion=' + $cv.DisplayVersion + '  BuildLab=' + $cv.BuildLab)
W ('  Windows.old exists = ' + (Test-Path 'C:\Windows.old'))
if (Test-Path 'C:\Windows.old\Windows\System32\ntoskrnl.exe') {
  W ('  old ntoskrnl = ' + (Get-Item 'C:\Windows.old\Windows\System32\ntoskrnl.exe').VersionInfo.FileVersion)
}

W '== 电源方案（含本会话改过的那两处）=='
$pr = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$plan = (Get-ItemProperty -Path $pr).ActivePowerScheme
$sub = '54533251-82be-4824-96c1-47b60b740d00'
W ('  active plan = ' + $plan)
$sets = @{ 'MIN' = '893dee8e-2bef-41e0-89c6-b55d0929964c'; 'MAX' = 'bc5038f7-23e0-4960-96da-33abaf5935ec'; 'EPP(我写的惰性值)' = '36687f9e-e3a5-4dbf-b1dc-15eb381c6863' }
foreach ($n in @('MIN', 'MAX', 'EPP(我写的惰性值)')) {
  $k = Join-Path $pr ($plan + '\' + $sub + '\' + $sets[$n])
  $v = (Get-ItemProperty -Path $k -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
  W ('  ' + $n + '(AC) = ' + $v)
}

W '== 症状读数 =='
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class PwrInfo3 {
  [StructLayout(LayoutKind.Sequential)]
  public struct PPI { public uint Number, MaxMhz, CurrentMhz, MhzLimit, MaxIdleState, CurrentIdleState; }
  [DllImport("powrprof.dll", SetLastError=true)] static extern uint CallNtPowerInformation(int L, IntPtr i, uint isz, IntPtr o, uint osz);
  public static PPI[] Get(int n){
    int sz = Marshal.SizeOf(typeof(PPI));
    IntPtr p = Marshal.AllocCoTaskMem(sz * n);
    CallNtPowerInformation(11, IntPtr.Zero, 0, p, (uint)(sz * n));
    PPI[] a = new PPI[n];
    for (int i = 0; i < n; i++) a[i] = (PPI)Marshal.PtrToStructure((IntPtr)((long)p + i * sz), typeof(PPI));
    Marshal.FreeCoTaskMem(p); return a;
  }
}
'@
$nlp = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
$a = [PwrInfo3]::Get($nlp)
W ('  NtPI cpu0 : cur=' + $a[0].CurrentMhz + ' max=' + $a[0].MaxMhz + ' limit=' + $a[0].MhzLimit)
W ('  NtPI cpu16: cur=' + $a[16].CurrentMhz + ' max=' + $a[16].MaxMhz + ' limit=' + $a[16].MhzLimit)
$set = @('\Processor Information(_Total)\Processor Frequency', '\Processor Information(_Total)\% Processor Performance')
$c = Get-Counter -Counter $set -SampleInterval 1 -MaxSamples 2 -ErrorAction SilentlyContinue
if ($c) {
  foreach ($g in ($c.CounterSamples | Group-Object Path)) {
    $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
    W ('  ' + ($g.Name -replace '^.*\\', '') + ' = ' + [math]::Round($avg, 1))
  }
}

W '== 最近服务/更新事件 =='
try {
  Get-WinEvent -LogName Setup -MaxEvents 10 -ErrorAction Stop | ForEach-Object {
    $m = ($_.Message -replace "\s+", " ")
    W ('  ' + $_.TimeCreated + ' [' + $_.Id + '] ' + $m.Substring(0, [Math]::Min(95, $m.Length)))
  }
} catch { W ('  setup log: ' + $_.Exception.Message) }
try {
  Get-HotFix -ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 5 | ForEach-Object {
    W ('  ' + $_.HotFixID + '  installed ' + $_.InstalledOn)
  }
} catch { }
W '# done'
