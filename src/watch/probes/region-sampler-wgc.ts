/**
 * WGC 窗口采样器（2026-10-30）
 *
 * 为什么加它：PowerShell 的 CopyFromScreen 按屏幕坐标截屏，有三个硬伤——
 *   1. 被遮挡即失效（截到的是盖住目标窗口的那个窗口）；
 *   2. DPI 缩放导致坐标错位（逻辑坐标 vs 物理坐标，150% 缩放时差 1.5 倍）；
 *   3. 窗口一挪/一缩放，region 坐标就作废。
 *
 * Windows Graphics Capture（WGC）抓的是**窗口自身的 surface**：即使窗口被
 * 遮挡、非焦点、DPI 缩放、位置变动，都能抓到该窗口的真实画面——一次绕过三个坑。
 * 具体抓取由 ~/.agent/bin/WgcCap.exe 完成（`win <title> -` 把 PNG 的 base64
 * 写到 stdout）。
 *
 * 内存与落盘（用户明确要求不落盘、不爆内存）：
 *   - 不落盘：WgcCap 输出到 stdout（`-`），这里直接 base64 → Buffer 内存解码；
 *   - 不爆内存：sharp 解码后**立刻**缩到 9x8 灰度（输出仅 72 字节），
 *     大图峰值只是单次解码缓冲（≈宽*高*4）；再用 limitInputPixels 兜底，
 *     拒绝超大图（>1 亿像素）而不是硬解爆内存。
 *
 * 边界：窗口最小化时 WGC 可能抓不到（返回空/黑图）→ 抛错，上层当一次采样失败。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

import { dhashFromGray } from './region-sampler-ps.js';

const execFileAsync = promisify(execFile);

const SAMPLE_TIMEOUT_MS = 15_000;
/** 32MB：足够容纳 4K 窗口的 base64 PNG（约 27MB），防 stdout 被截断 */
const MAX_BUFFER = 32 * 1024 * 1024;
/** 1 亿像素上限：超出直接拒绝解码，防超大图爆内存 */
const MAX_INPUT_PIXELS = 100_000_000;

/** WgcCap.exe 路径（~/.agent/bin/WgcCap.exe，仅 Windows） */
function resolveWgcCapPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.agent', 'bin', 'WgcCap.exe');
}

/**
 * 按窗口标题抓窗口内容 → 内存解码 → 缩 9x8 灰度 → dHash（16 位十六进制）。
 *
 * @param windowTitle 窗口标题（子串匹配，WgcCap 内部分辨率最低的那个匹配窗口）
 * @returns 16 位 hex 指纹，与 region-sampler-ps 的 dHash 同语义（可直接比较汉明距离）
 */
export async function sampleWindowViaWgc(windowTitle: string): Promise<string> {
  if (!windowTitle || windowTitle.trim().length === 0) {
    throw new Error('windowTitle 为空');
  }

  const exe = resolveWgcCapPath();
  const { stdout } = await execFileAsync(exe, ['win', windowTitle, '-'], {
    timeout: SAMPLE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });

  const b64 = String(stdout).trim();
  if (b64.length === 0) {
    // 常见原因：窗口已关闭 / 最小化 / 标题不匹配
    throw new Error('WgcCap 返回空（窗口可能已关闭/最小化/标题不匹配）');
  }

  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) {
    throw new Error('WgcCap base64 解码为空');
  }

  // sharp 内存解码 → 缩 9x8 → 灰度，输出 72 字节
  const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
    throw new Error(`WgcCap 采样尺寸异常: ${info.width}x${info.height}, ${data.length} bytes`);
  }

  return dhashFromGray(Array.from(data));
}
