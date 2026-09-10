/**
 * ffmpeg 可选依赖服务（多模态视频输入）—— 动态探测，无则静默降级。
 *
 * 用途：
 * - probeVideo：ffprobe 探测视频元信息（时长/fps/分辨率），供 token 预算估算；
 * - extractFrames：ffmpeg 抽帧 → PNG Buffer[]，供"非原生视频模型/超限视频"降级为图片数组。
 *
 * 可选依赖原则：ffmpeg 不在系统 PATH 时返回 null/[]，调用方走内联或 file 引用降级，不写死依赖。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

let _available: boolean | null = null;

/** 探测 ffmpeg/ffprobe 是否可用（结果缓存；ENOENT 等视为不可用） */
export async function ffmpegAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    await execFileAsync('ffprobe', ['-version'], { windowsHide: true });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/** 测试用：重置探测缓存（允许 mock 环境注入状态） */
export function resetFfmpegProbe(): void {
  _available = null;
}

export interface VideoProbe {
  duration: number; // 秒
  fps: number;
  width: number;
  height: number;
}

/** ffprobe 探测视频元信息；无 ffprobe / 失败 → null */
export async function probeVideo(filePath: string): Promise<VideoProbe | null> {
  if (!(await ffmpegAvailable())) return null;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
        '-of', 'json',
        filePath,
      ],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const data = JSON.parse(stdout) as {
      streams?: Array<{ width?: string; height?: string; r_frame_rate?: string; duration?: string }>;
      format?: { duration?: string };
    };
    const s = data.streams?.[0];
    const fpsParts = String(s?.r_frame_rate ?? '').split('/');
    const fps = fpsParts.length === 2 && Number(fpsParts[1]) !== 0
      ? Number(fpsParts[0]) / Number(fpsParts[1])
      : 0;
    return {
      duration: Number(s?.duration ?? data.format?.duration ?? 0) || 0,
      fps: fps || 0,
      width: Number(s?.width ?? 0),
      height: Number(s?.height ?? 0),
    };
  } catch {
    return null;
  }
}

export interface FrameExtractOptions {
  /** 采样帧率（默认 1fps） */
  fps?: number;
  /** 最大帧数（硬约束，控制上下文 token 激增，默认 16） */
  max_frames?: number;
  /** 帧长边缩放上限（默认 1024） */
  max_long_side_pixel?: number;
}

/**
 * ffmpeg 抽帧 → PNG Buffer[]。
 * 无 ffmpeg / 失败 → []（调用方降级）。
 * 实现：临时目录逐帧写文件再读回（避免解析拼接 PNG 流），用完即删。
 */
export async function extractFrames(
  filePath: string,
  opts: FrameExtractOptions = {},
): Promise<Buffer[]> {
  if (!(await ffmpegAvailable())) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-frames-'));
  try {
    const fps = opts.fps ?? 1;
    const maxFrames = opts.max_frames ?? 16;
    const vf: string[] = [`fps=${fps}`];
    if (opts.max_long_side_pixel) {
      vf.push(
        `scale=min(${opts.max_long_side_pixel},iw):min(${opts.max_long_side_pixel},ih):force_original_aspect_ratio=decrease`,
      );
    }
    const args = ['-v', 'error', '-i', filePath];
    if (vf.length > 0) args.push('-vf', vf.join(','));
    args.push('-frames:v', String(maxFrames), '-f', 'image2', path.join(dir, 'frame_%04d.png'));
    await execFileAsync('ffmpeg', args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f)));
  } catch {
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
