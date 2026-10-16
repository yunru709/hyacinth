# 截取指定进程的主窗口（含标题栏）为 PNG。
# 为什么需要：shot.mjs 只能截网页内容（走 CDP），看不到**原生窗口本身**的长相。
# 用法：powershell -File shot-window.ps1 -Proc native-shell -Out C:\path\shot.png
param(
  [string]$Proc = 'native-shell',
  [string]$Out  = 'C:\Users\74689\Desktop\Agent\hyacinth\outputs\gui-probe\window.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

# ⚠️ 必须先声明 DPI 感知。否则本进程拿到的是"逻辑坐标"——在 150% 缩放下
# GetWindowRect 会因系统 DPI 虚拟化返回错位的矩形，截出来的是窗口的一角
# （2026-10-16 实测：截到的是界面右下局部，还误以为页面渲染坏了）。
[void][Win32Shot]::SetProcessDPIAware()

$p = Get-Process -Name $Proc -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $p) { Write-Output "NO_WINDOW: 进程 $Proc 没有可见主窗口"; exit 2 }

$h = $p.MainWindowHandle
[void][Win32Shot]::ShowWindow($h, 9)   # SW_RESTORE
[void][Win32Shot]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700          # 等窗口真正前置/重绘

$r = New-Object Win32Shot+RECT
if (-not [Win32Shot]::GetWindowRect($h, [ref]$r)) { Write-Output "GetWindowRect 失败"; exit 3 }

$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { Write-Output "窗口尺寸异常: ${w}x${hh}"; exit 4 }

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Output ("OK -> {0}  ({1}x{2}, rect={3},{4})" -f $Out, $w, $hh, $r.Left, $r.Top)
