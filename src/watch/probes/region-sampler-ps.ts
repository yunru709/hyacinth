/**
 * PowerShell 兜底区域采样器（2026-10-29）
 *
 * 为什么用 PowerShell：框架是 Node，没有原生截屏能力；引入 native 模块或
 * 依赖 MCP 都会破坏分层。PowerShell + System.Drawing 是零新增依赖里最直接的方案。
 *
 * 性能代价（明确记录）：每次采样要启动一个 powershell 进程，约 150–300ms。
 * 对 background 模式（默认 2s 一次）约 10% 单核开销；对 wait 模式（500ms 一次）
 * 偏高。后续应换成 windows-mcp 的 GrabRegionHash（进程常驻、只回哈希），
 * 通过 ui-region.ts 的 setDefaultRegionSampler() 替换即可。
 *
 * 两个坑（都已处理）：
 *   1. DPI 缩放：未声明 DPI aware 的进程调用 CopyFromScreen 会拿到缩放后的坐标，
 *      截到错误区域。脚本开头 SetProcessDPIAware() 修复。
 *   2. 长脚本转义：-Command 传多行脚本容易被引号规则吃掉，改用 -EncodedCommand
 *      （UTF-16LE + base64），彻底绕开转义。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Region } from '../types.js';

const execFileAsync = promisify(execFile);

const SAMPLE_TIMEOUT_MS = 15_000;

/** 截 region（或整屏）→ 缩成 9x8 灰度 → 输出 72 个逗号分隔的灰度值 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WmcpDpi{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[WmcpDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$r = $env:WMCP_REGION
if ($r) {
  $p = $r -split ','
  $x = [int]$p[0]; $y = [int]$p[1]
  $w = [int]$p[2] - $x; $h = [int]$p[3] - $y
} else {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
}
// ⚠️ 坑：本脚本是 TS 模板字符串，PowerShell 的「美元+花括号」插值会被 JS 抢先解析
// （曾导致 "ReferenceError: w is not defined"，且只在模块加载时暴露）。
// 因此脚本里禁止出现该形式，需要拼接时用 'a' + $var。
if ($w -le 0 -or $h -le 0) { throw ('invalid capture size ' + $w + 'x' + $h) }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$small = New-Object System.Drawing.Bitmap 9, 8
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, 9, 8)
$vals = New-Object System.Collections.Generic.List[int]
for ($yy = 0; $yy -lt 8; $yy++) {
  for ($xx = 0; $xx -lt 9; $xx++) {
    $c = $small.GetPixel($xx, $yy)
    $vals.Add([int](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B))
  }
}
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()
$vals -join ','
`;

/** 72 个灰度值（9x8）→ 64 位 dHash 的 16 位十六进制 */
export function dhashFromGray(pixels: number[]): string {
  if (pixels.length !== 72) {
    throw new Error(`expected 72 gray values (9x8), got ${pixels.length}`);
  }
  let bits = 0n;
  const rowWidth = 9;
  for (let row = 0; row < 8; row += 1) {
    const base = row * rowWidth;
    for (let col = 0; col < 8; col += 1) {
      // 左亮于右记 1 —— 与 windows-mcp 的 dHash 保持同一语义
      bits = (bits << 1n) | (pixels[base + col] > pixels[base + col + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** 采集区域指纹（16 位十六进制）。region 省略 = 整屏。 */
export async function sampleRegionViaPowerShell(region?: Region): Promise<string> {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      timeout: SAMPLE_TIMEOUT_MS,
      windowsHide: true,
      env: {
        ...process.env,
        WMCP_REGION: region ? region.join(',') : '',
      },
    },
  );

  const raw = String(stdout).trim();
  const pixels = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  return dhashFromGray(pixels);
}
