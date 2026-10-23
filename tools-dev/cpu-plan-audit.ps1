# cpu-plan-audit.ps1
# Decisive probes for "why is Task Manager's CPU speed frozen at 2.10 GHz, and is
# the OS in control of the CPU clock at all?".
#
# 1) The active plan (高性能) has PROCTHROTTLEMIN=100% on AC -> the OS asks for max
#    performance even at idle. (previous test moved only MAX while MIN stayed 100.)
# 2) Probe A = current plan as-is; Probe B = powercfg /setactive SCHEME_BALANCED
#    (min=5%), i.e. the standard user-facing knob. Everything is restored at the end.
#
# Interpretation:
#   * %perf + spin throughput drop in B  => the OS PPM really drives the clock and
#     the ratio counter is honest => the frozen 2.10 GHz is a *reporting* problem.
#   * nothing changes in B              => the OS PPM is disconnected from this
#     CPU's clock domain (firmware/EC owns it) => frozen readout + inert plan are
#     two symptoms of the same disconnect.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'cpu-plan-audit.log'
Set-Content -LiteralPath $log -Value '' -Encoding UTF8
function W([string]$m) { Write-Host $m; Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }

$node = (Get-Command node).Source
$spin = Join-Path $root 'spin.mjs'
$out = Join-Path $root 'plan-out'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$SUB_PROC = '54533251-82be-4824-96c1-47b60b740d00'
$SET_MIN = '893dee8e-2bef-41e0-89c6-b55d0929964c'
$SET_MAX = 'bc5038f7-23e0-4960-96da-33abaf5935ec'
$powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
$pp = Get-ItemProperty -Path $powerRoot
$scheme = $pp.ActivePowerScheme
W ('active scheme = ' + $scheme)
W ('overlay AC/DC = ' + $pp.ActiveOverlayAcPowerScheme + ' / ' + $pp.ActiveOverlayDcPowerScheme)

function Get-Setting([string]$schemeGuid, [string]$settingGuid) {
  $p = Join-Path $powerRoot ($schemeGuid + '\' + $SUB_PROC + '\' + $settingGuid)
  $v = (Get-ItemProperty -Path $p -Name ACSettingIndex -ErrorAction SilentlyContinue).ACSettingIndex
  if ($null -eq $v) { $v = -999 }   # not present in this scheme (inherited)
  return $v
}
function Show-MinMax([string]$schemeGuid) {
  W ('  plan ' + $schemeGuid + ' : MIN(AC)=' + (Get-Setting $schemeGuid $SET_MIN) + '  MAX(AC)=' + (Get-Setting $schemeGuid $SET_MAX))
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PwrInfo2 {
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
$nlp = 24
function Show-NtPi([string]$tag) {
  $a = [PwrInfo2]::Get($nlp)
  W ('  NtPowerInfo[' + $tag + '] cur=' + $a[0].CurrentMhz + ' max=' + $a[0].MaxMhz + ' limit=' + $a[0].MhzLimit)
}

function Show-Counters([string]$tag) {
  $set = @('\Processor Information(_Total)\Processor Frequency',
           '\Processor Information(_Total)\% Processor Performance',
           '\Processor Information(_Total)\% of Maximum Frequency',
           '\Processor Information(_Total)\% Processor Time')
  $c = Get-Counter -Counter $set -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
  if ($c) {
    $line = @()
    foreach ($g in ($c.CounterSamples | Group-Object Path)) {
      $avg = ($g.Group | Measure-Object -Property CookedValue -Average).Average
      $n = $g.Name -replace '^.*\\', ''
      $line += ($n + '=' + [math]::Round($avg, 1))
    }
    W ('  counters[' + $tag + '] ' + ($line -join '  '))
  }
}

function Run-SpinOnce([string]$tag, [int]$ms) {
  $f = Join-Path $out ($tag + '.txt')
  Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $node -ArgumentList @($spin, "$ms") -PassThru -WindowStyle Hidden -RedirectStandardOutput $f
  Start-Sleep -Milliseconds 2500
  Show-Counters ($tag + ' loaded')
  $p | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
  try { if (-not $p.HasExited) { $p.Kill() } } catch {}
  $t = (Get-Content -LiteralPath $f -Raw).Trim()
  if ($t) {
    $it = (ConvertFrom-Json $t).iters
    $rate = [int]($it / ($ms / 1000.0))
    W ('  spin[' + $tag + '] iters/s = ' + $rate)
    return $rate
  }
  W ('  spin[' + $tag + '] no output')
  return 0
}

$rA = 0; $rB = 0
try {
  W ''
  W '===== PROBE A: current plan (as configured by the user) ====='
  Show-MinMax $scheme
  Show-NtPi 'A idle'
  Show-Counters 'A idle'
  $rA = Run-SpinOnce 'A_1t' 8000

  W ''
  W '===== PROBE B: SCHEME_BALANCED (min=5%) ====='
  powercfg /setactive SCHEME_BALANCED
  $rc = $LASTEXITCODE
  Start-Sleep -Milliseconds 2500
  $now = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
  W ('  setactive rc=' + $rc + '  now active = ' + $now)
  Show-MinMax $now
  Show-NtPi 'B idle'
  Show-Counters 'B idle'
  $rB = Run-SpinOnce 'B_1t' 8000
  W ('  1-thread spin ratio A/B = ' + $(if ($rB -gt 0) { [math]::Round($rA / $rB, 3) } else { 'n/a' }))
} finally {
  W ''
  W '===== RESTORE original plan ====='
  powercfg /setactive $scheme
  $rc = $LASTEXITCODE
  Start-Sleep -Milliseconds 2500
  $now = (Get-ItemProperty -Path $powerRoot).ActivePowerScheme
  W ('  restore rc=' + $rc + '  now active = ' + $now)
  Show-MinMax $now
  Show-Counters 'restored idle'
}
W '# done'
