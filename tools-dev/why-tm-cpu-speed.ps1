# why-tm-cpu-speed.ps1
# Purpose: find out why Task Manager "速度" is pinned at the base clock (2100 MHz)
# while the CPU really boosts. Collects OS/CPU facts, VBS/hypervisor state, power
# settings, CallNtPowerInformation(ProcessorInformation), and PDH counters at
# idle / 1-thread / 24-thread load.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $root 'why-tm-cpu-speed.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

W ('# time: ' + (Get-Date).ToString('s'))
$os = Get-CimInstance Win32_OperatingSystem
W ('OS: ' + $os.Caption + '  build ' + $os.BuildNumber + '.' + $os.UBR)
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
W ('CPU: ' + $cpu.Name + '  cores=' + $cpu.NumberOfCores + ' lps=' + $cpu.NumberOfLogicalProcessors)
W ('Win32_Processor: MaxClockSpeed=' + $cpu.MaxClockSpeed + ' CurrentClockSpeed=' + $cpu.CurrentClockSpeed)

W ''
W '== Hypervisor / VBS =='
try {
  $dg = Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop
  W ('VBS status (0=off,1=configured,2=running): ' + $dg.VirtualizationBasedSecurityStatus)
  W ('SecurityServicesRunning: ' + (@($dg.SecurityServicesRunning) -join ','))
  W ('SecurityServicesConfigured: ' + (@($dg.SecurityServicesConfigured) -join ','))
} catch { W ('DeviceGuard query failed: ' + $_.Exception.Message) }
W ('Win32_ComputerSystem.HypervisorPresent: ' + (Get-CimInstance Win32_ComputerSystem).HypervisorPresent)
$bcd = Join-Path $env:SystemRoot 'System32\bcdedit.exe'
try { W ((& $bcd /enum '{current}') 2>&1 | Select-String -Pattern 'hypervisorlaunchtype|vsmlaunchtype' | Out-String) }
catch { W ('bcdedit failed: ' + $_.Exception.Message) }

W ''
W '== Power =='
W (((powercfg /getactivescheme) | Out-String).Trim())
$pcOut = Join-Path $root 'powercfg-subprocessor.txt'
powercfg /q SCHEME_CURRENT SUB_PROCESSOR | Out-File -FilePath $pcOut -Encoding UTF8
W ('SUB_PROCESSOR dump -> ' + $pcOut)

W ''
W '== CallNtPowerInformation(ProcessorInformation) =='
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PwrInfo {
  [StructLayout(LayoutKind.Sequential)]
  public struct PPI {
    public uint Number; public uint MaxMhz; public uint CurrentMhz;
    public uint MhzLimit; public uint MaxIdleState; public uint CurrentIdleState;
  }
  [DllImport("powrprof.dll", SetLastError = true)]
  static extern uint CallNtPowerInformation(int InformationLevel, IntPtr lpInputBuffer,
    uint nInputBufferSize, IntPtr lpOutputBuffer, uint nOutputBufferSize);
  public static PPI[] Get(int n) {
    int sz = Marshal.SizeOf(typeof(PPI));
    IntPtr p = Marshal.AllocCoTaskMem(sz * n);
    CallNtPowerInformation(11, IntPtr.Zero, 0, p, (uint)(sz * n));
    PPI[] a = new PPI[n];
    for (int i = 0; i < n; i++)
      a[i] = (PPI)Marshal.PtrToStructure((IntPtr)((long)p + i * sz), typeof(PPI));
    Marshal.FreeCoTaskMem(p);
    return a;
  }
}
'@
$nlp = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
$ppi = [PwrInfo]::Get($nlp)
W ('cpus reported = ' + $ppi.Length)
W (($ppi | ForEach-Object { 'cpu{0}: cur={1} max={2} limit={3} idle={4}/{5}' -f $_.Number, $_.CurrentMhz, $_.MaxMhz, $_.MhzLimit, $_.CurrentIdleState, $_.MaxIdleState }) -join '  ')

W ''
function Get-Snap([string]$tag) {
  W ('--- ' + $tag + ' ---')
  $set = @('\Processor Information(_Total)\Processor Frequency',
           '\Processor Information(_Total)\% Processor Performance',
           '\Processor Information(_Total)\% of Maximum Frequency',
           '\Processor Information(_Total)\% Processor Time')
  $c = Get-Counter -Counter $set -SampleInterval 1 -MaxSamples 2 -ErrorAction SilentlyContinue
  if ($c) {
    foreach ($g in ($c.CounterSamples | Group-Object Path)) {
      $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
      W ('{0} = {1:N1}' -f $g.Name, $avg)
    }
  } else { W '  [counter read failed]' }
  $pc = Get-Counter -Counter '\Processor Information(*)\% Processor Performance' -SampleInterval 1 -MaxSamples 2 -ErrorAction SilentlyContinue
  if ($pc) {
    $top = $pc.CounterSamples | Sort-Object CookedValue -Descending | Select-Object -First 8
    W ('  top per-core %Perf: ' + (($top | ForEach-Object { '{0}={1:N0}' -f $_.InstanceName, $_.CookedValue }) -join ' '))
  }
  $pp = [PwrInfo]::Get($nlp)
  W ('  NtPowerInfo cur(MHz): ' + (($pp | Select-Object -First 6 | ForEach-Object { $_.CurrentMhz }) -join ',') + ' ...')
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$spin = Join-Path $root 'spin.mjs'
$outDir = Join-Path $root 'spin-out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
function Start-Spin([int]$count, [int]$ms, [string]$tag) {
  $procs = @()
  for ($i = 0; $i -lt $count; $i++) {
    $o = Join-Path $outDir ('s_{0}_{1}_{2}.txt' -f $tag, $ms, $i)
    Remove-Item -LiteralPath $o -ErrorAction SilentlyContinue
    $procs += (Start-Process -FilePath $node -ArgumentList @($spin, "$ms") -PassThru -WindowStyle Hidden -RedirectStandardOutput $o)
  }
  return , $procs
}
function Read-Spin([string]$tag, [int]$ms) {
  $items = @()
  Get-ChildItem -Path $outDir -Filter ('s_{0}_{1}_*.txt' -f $tag, $ms) | ForEach-Object {
    $t = (Get-Content -LiteralPath $_.FullName -Raw).Trim()
    if ($t) { $items += (ConvertFrom-Json $t) }
  }
  if ($items.Count -gt 0) {
    $sum = ($items | Measure-Object -Property iters -Sum).Sum
    W ('  spin[' + $tag + '] threads=' + $items.Count + ' iters/thread=' + [int]($sum / $items.Count) + ' total=' + $sum)
  } else { W ('  spin[' + $tag + '] no output') }
}

W ''
W '== PHASE 1: idle baseline =='
Get-Snap 'idle'
$idleCpu = (Get-Counter '\Processor Information(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 2).CounterSamples | Measure-Object -Property CookedValue -Average
W ('  (idle %ProcessorTime = ' + [math]::Round($idleCpu.Average, 1) + ')')

W ''
W '== PHASE 2: 1 busy thread =='
$p1 = Start-Spin 1 12000 't1'
Start-Sleep -Milliseconds 2500
Get-Snap '1 thread'
$p1 | Wait-Process -Timeout 40 -ErrorAction SilentlyContinue
Read-Spin 't1' 12000

W ''
W '== PHASE 3: 24 busy threads =='
$p24 = Start-Spin 24 12000 't24'
Start-Sleep -Milliseconds 3000
Get-Snap '24 threads'
$p24 | Wait-Process -Timeout 40 -ErrorAction SilentlyContinue
Read-Spin 't24' 12000
foreach ($p in ($p24 + $p1)) { try { if (-not $p.HasExited) { $p.Kill() } } catch {} }

W ''
W '== PHASE 4: back to idle =='
Start-Sleep -Milliseconds 2000
Get-Snap 'idle again'
W '# done'
