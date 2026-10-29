/**
 * ui_region probe —— 屏幕区域变化检测（2026-10-29）
 *
 * 分层取舍：框架是 Node，没有原生截屏能力；直接把"截图"写进 probe 会让
 * watch 层依赖具体的截图后端（PowerShell / MCP / native 模块）。所以这里做
 * **依赖倒置**：probe 只要求一个 `RegionSampler`（给定区域，返回一个可比较的指纹），
 * 具体怎么采由上层注入。
 *
 * 默认注入的是 PowerShell 兜底实现（region-sampler-ps.ts，零新增依赖，开箱可用）；
 * 后续可换成 windows-mcp 的 GrabRegionHash（只回哈希不回图，更快更省），
 * 换的时候只需 `setDefaultRegionSampler()`，本文件一行不用改。
 *
 * 指纹与距离：
 *   sampler 返回 **16 位十六进制**（64 位 dHash），distance 用汉明距离。
 *   用 hex 而不是 number 是因为 64 位超过 JS 安全整数范围（2^53），
 *   转成 number 会丢精度，导致"明明变了却算出 0 距离"。
 */

import type { Probe, ProbeInstance, ProbeSample, Region, UiRegionSpec } from '../types.js';

/** 给定区域返回指纹（16 位十六进制）。region 为空表示整屏。 */
export type RegionSampler = (region?: Region) => Promise<string>;

let injectedSampler: RegionSampler | null = null;

/** 注入采样器（上层接入 MCP / native 实现时用） */
export function setDefaultRegionSampler(sampler: RegionSampler | null): void {
  injectedSampler = sampler;
}

async function resolveSampler(): Promise<RegionSampler> {
  if (injectedSampler) return injectedSampler;
  // 惰性加载兜底实现：只有真的用到 ui_region 时才把它拉进来
  const mod = await import('./region-sampler-ps.js');
  return mod.sampleRegionViaPowerShell;
}

/** 两个 64 位十六进制指纹的汉明距离（0..64） */
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) {
    // 指纹格式不对时退化成"不等即 64"，让调用方看见异常而不是静默 0
    return a === b ? 0 : 64;
  }
  let v = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (v > 0n) {
    if (v & 1n) count += 1;
    v >>= 1n;
  }
  return count;
}

class UiRegionProbeInstance implements ProbeInstance {
  constructor(private readonly spec: UiRegionSpec) {}

  async sample(signal?: AbortSignal): Promise<ProbeSample> {
    if (signal?.aborted) return { ok: false, value: '', error: 'aborted' };
    try {
      const sampler = await resolveSampler();
      const value = await sampler(this.spec.region);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, value: '', error: `region sample failed: ${(err as Error).message}` };
    }
  }

  distance(baseline: ProbeSample, current: ProbeSample): number {
    if (!baseline.ok || !current.ok) return 0; // 失败不算变化
    return hammingDistanceHex(baseline.value, current.value);
  }
}

export const uiRegionProbe: Probe = {
  kind: 'ui_region',
  description: '屏幕区域画面变化（dHash 汉明距离）。建议限定 region，否则光标闪烁即误报',
  create(spec) {
    if (spec.kind !== 'ui_region') throw new Error('uiRegionProbe received mismatched spec');
    const region = spec.region;
    if (region) {
      if (region.length !== 4) {
        throw new Error(
          `ui_region: region must have exactly 4 numbers [left, top, right, bottom], got ${region.length}`,
        );
      }
      const [l, t, r, b] = region;
      if (r <= l || b <= t) throw new Error('ui_region: region must satisfy right > left and bottom > top');
    }
    if (spec.threshold !== undefined && (spec.threshold < 0 || spec.threshold > 64)) {
      throw new Error('ui_region: threshold must be within 0..64');
    }
    return new UiRegionProbeInstance(spec);
  },
};
