/**
 * Watch 工具层（2026-10-29）
 *
 * 四个工具，对应两种形态：
 *   watch_wait   —— 同步等待（阻塞到变化/超时），适合「盯着等一两分钟」
 *   watch_start  —— 后台挂起（立即返回），适合「可能几小时后才发生」
 *   watch_list   —— 列出在跑的监控 + 最近事件
 *   watch_stop   —— 停止某个监控
 *
 * 唤醒链路（阶段 4）：
 *   watch 命中 → WatchEvent（带 owner=登记它的会话）
 *              → SessionWakePort.runPrompt(channel, sessionId, 自带提示词)
 *              → 该会话跑一轮
 *
 * 为什么不用 notifyTaskFired：那条路径会套上 `[Scheduled Task Triggered] ... your
 * scheduled task "X" has just been triggered`，对「监控项变化」是错误语义，
 * 会让我误以为在执行定时任务。这里自带提示词，端口只负责跑这一轮。
 *
 * 归属（owner）是必须的：watch 服务是进程级单例，多个会话可能同时挂监控，
 * 没有 owner 就会串线（A 会话的监控把 B 会话叫醒）。
 */

import { getSchedulerSessionPort } from '../schedule/session-port.js';
import { getGlobalTriggerHub } from '../trigger/hub.js';
import type { Tool } from '../tools/interface.js';
import { createDefaultProbeRegistry } from './probes/index.js';
import { getWatchService, onWatchEvent } from './service-instance.js';
import type { WatchSpec } from './types.js';
import type { WatchEvent, WatchOwner, WatchService } from './watch-service.js';
import { waitForChange } from './wait.js';

/** 同步等待上限：框架侧工具超时 300s，但阻塞太久会卡住整个回合，取 90s 封顶 */
const MAX_WAIT_MS = 90_000;
const DEFAULT_WAIT_MS = 25_000;
const RECENT_EVENT_LIMIT = 50;

const recentEvents: WatchEvent[] = [];

function pushEvent(event: WatchEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > RECENT_EVENT_LIMIT) recentEvents.shift();
}

/** 事件转成唤醒提示词。要点：说清"是什么触发了"，并明确不需要重新登记监控。 */
export function buildWatchPrompt(event: WatchEvent): string {
  return [
    '[Watch Event]',
    `监控项「${event.note ?? event.summary}」发生了变化。`,
    `- watchId: ${event.watchId}`,
    `- 类型: ${event.kind}`,
    `- 变化程度: ${event.distance}`,
    `- 时间: ${new Date(event.at).toISOString()}`,
    '',
    '这是你之前用 watch_start 登记的后台监控触发了。请判断是否需要行动：',
    '需要就直接处理；不需要就说明一句。监控会在冷却期后自动继续，不要重复登记；',
    '如果已经不需要它，用 watch_stop 停掉。',
  ].join('\n');
}

/** 唤醒 owner 会话。失败只记录日志——监控本身不该因为唤醒失败而中断。
 *  export 出去供 condition-runner 复用（自动化任务的条件触发走同一条唤醒路径）。 */
export async function wakeOwner(event: WatchEvent): Promise<void> {
  const owner = event.owner;
  if (!owner) return;
  const port = getSchedulerSessionPort();
  if (!port?.runPrompt) return; // 端口未接线（如测试环境）：仅记录事件
  try {
    await port.runPrompt(owner.channel, owner.sessionId, buildWatchPrompt(event));
  } catch (err) {
    console.error('[watch] wake session failed:', (err as Error).message);
  }
}

let service: WatchService | null = null;

function getService(): WatchService {
  if (!service) {
    service = new WatchService({
      registry: createDefaultProbeRegistry(),
      onEvent: (event) => {
        pushEvent(event);
        // 不 await：唤醒一轮可能很久，不能阻塞采样循环
        void wakeOwner(event);
        // 同步外发到触发总线（若已接线）：让"时间触发"和"监控触发"在同一个
        // 地方可观测/可统计。hub 未接线时为 no-op，不影响任何现有行为。
        const hub = getGlobalTriggerHub();
        if (hub) {
          void hub.fire({
            source: 'watch',
            name: event.note ?? event.summary,
            detail: {
              watchId: event.watchId,
              kind: event.kind,
              distance: event.distance,
              owner: event.owner,
            },
          });
        }
      },
    });
  }
  return service;
}

const SPEC_PROPS: Record<string, unknown> = {
  kind: {
    type: 'string',
    enum: ['file', 'http', 'process', 'port', 'ui_region'],
    description:
      'file: 文件出现/内容变化; http: 端点状态或等到指定条件; process: 进程启动/退出; port: 端口开/关; ui_region: 屏幕区域变化(需 MCP 支持)',
  },
  path: { type: 'string', description: 'file: 文件路径' },
  watch: { type: 'string', enum: ['content', 'mtime'], description: 'file: 默认 content' },
  url: { type: 'string', description: 'http: 完整 URL' },
  method: { type: 'string', enum: ['GET', 'HEAD', 'POST'], description: 'http: 默认 GET' },
  expectStatus: { type: 'number', description: 'http: 期望状态码，命中即视为达成' },
  expectContains: { type: 'string', description: 'http: 期望响应体包含的文本' },
  headers: { type: 'object', description: 'http: 额外请求头' },
  name: { type: 'string', description: 'process: 进程名（与 pid 二选一）' },
  pid: { type: 'number', description: 'process: 进程 ID（与 name 二选一）' },
  expect: {
    type: 'string',
    enum: ['running', 'exit', 'open', 'closed'],
    description: 'process: running|exit；port: open|closed',
  },
  host: { type: 'string', description: 'port: 主机，默认 127.0.0.1' },
  port: { type: 'number', description: 'port: 端口号' },
  region: {
    type: 'array',
    items: { type: 'number' },
    description: 'ui_region: [left, top, right, bottom]',
  },
  allowPrivateHost: {
    type: 'boolean',
    description: '是否允许探测内网地址（默认 false，仅放行本机与公网）',
  },
};

const TUNING_PROPS: Record<string, unknown> = {
  interval_ms: { type: 'number', description: '采样间隔，默认 500(wait) / 2000(background)' },
  threshold: { type: 'number', description: '距离阈值，超过才算变化，默认 0' },
  settle_frames: { type: 'number', description: '连续 N 帧命中才算变化，默认 1' },
};

function buildSpec(args: Record<string, unknown>): WatchSpec {
  const kind = String(args.kind ?? '');
  const base = { kind } as Record<string, unknown>;
  for (const key of [
    'path',
    'watch',
    'url',
    'method',
    'expectStatus',
    'expectContains',
    'headers',
    'name',
    'pid',
    'expect',
    'host',
    'port',
    'region',
    'allowPrivateHost',
  ]) {
    if (args[key] !== undefined) base[key] = args[key];
  }
  return base as unknown as WatchSpec;
}

const watchWaitTool: Tool = {
  name: 'watch_wait',
  description:
    '阻塞等待某个条件成立（或超时），返回是否变化。只回一个小的 JSON，不含图片，' +
    '比反复截图便宜得多。适合短时等待：等文件写完、等端口起来、等接口返回 200、等进程退出。' +
    '最长 90 秒；要等更久请用 watch_start 后台挂起。',
  inputSchema: {
    type: 'object',
    properties: {
      ...SPEC_PROPS,
      timeout_s: { type: 'number', description: '最长等待秒数，默认 25，上限 90' },
      ...TUNING_PROPS,
    },
    required: ['kind'],
  },
  sideEffect: 'read',
  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    let spec: WatchSpec;
    try {
      spec = buildSpec(args);
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }

    const timeoutMs = Math.min(
      MAX_WAIT_MS,
      Math.max(1_000, Number(args.timeout_s ?? DEFAULT_WAIT_MS / 1000) * 1_000),
    );

    let probe;
    try {
      probe = createDefaultProbeRegistry().create(spec);
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }

    const result = await waitForChange({
      kind: spec.kind,
      probe,
      timeoutMs,
      intervalMs: args.interval_ms === undefined ? undefined : Number(args.interval_ms),
      threshold: args.threshold === undefined ? undefined : Number(args.threshold),
      settleFrames: args.settle_frames === undefined ? undefined : Number(args.settle_frames),
      signal,
    });

    return JSON.stringify(result);
  },
};

/** 工厂：绑定 owner 后，该会话登记的监控触发时只唤醒它自己 */
function makeWatchStartTool(owner?: WatchOwner): Tool {
  return {
    name: 'watch_start',
    description:
      '启动一个后台监控，立即返回 watchId（不阻塞）。条件成立时会唤醒你处理，' +
      '也可用 watch_list 查看累积的事件。适合「可能要等很久」的场合。' +
      '每个监控触发后进入冷却期（默认 30 秒）再继续，避免事件风暴。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_PROPS,
        note: { type: 'string', description: '备注，便于辨认这条监控' },
        once: { type: 'boolean', description: '触发一次后自动停止' },
        cooldown_s: { type: 'number', description: '命中后的冷却秒数，默认 30' },
        ...TUNING_PROPS,
      },
      required: ['kind'],
    },
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const spec = buildSpec(args);
        const info = getService().start(spec, {
          note: args.note === undefined ? undefined : String(args.note),
          once: args.once === true,
          cooldownMs: args.cooldown_s === undefined ? undefined : Number(args.cooldown_s) * 1000,
          intervalMs: args.interval_ms === undefined ? undefined : Number(args.interval_ms),
          threshold: args.threshold === undefined ? undefined : Number(args.threshold),
          settleFrames: args.settle_frames === undefined ? undefined : Number(args.settle_frames),
          owner,
        });
        return JSON.stringify({ ok: true, watch: info, willWakeSession: Boolean(owner) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
      }
    },
  };
}

const watchStopTool: Tool = {
  name: 'watch_stop',
  description:
    '停止一个由 watch_start 启动的后台监控。停止后不再采样、不再产生新事件；' +
    '已记录的历史事件仍可用 watch_list 查看。需要用 watchId（watch_start 的返回值）。',
  inputSchema: {
    type: 'object',
    properties: { watchId: { type: 'string', description: 'watch_start 返回的 id' } },
    required: ['watchId'],
  },
  sideEffect: 'read',
  async execute(args: Record<string, unknown>): Promise<string> {
    const id = String(args.watchId ?? '');
    const stopped = getService().stop(id);
    return JSON.stringify({ ok: stopped, watchId: id, error: stopped ? undefined : 'not found' });
  },
};

const watchListTool: Tool = {
  name: 'watch_list',
  description: '列出所有在跑的后台监控，以及最近触发的事件（最多 50 条）。',
  inputSchema: {
    type: 'object',
    properties: {
      event_limit: { type: 'number', description: '返回最近多少条事件，默认 10' },
    },
  },
  sideEffect: 'read',
  async execute(args: Record<string, unknown>): Promise<string> {
    const limit = Math.max(1, Math.min(RECENT_EVENT_LIMIT, Number(args.event_limit ?? 10)));
    return JSON.stringify({
      ok: true,
      watches: getService().list(),
      events: recentEvents.slice(-limit),
    });
  },
};

/**
 * 创建 watch 工具集。
 * @param deps.owner 归属会话；给了才会在事件触发时唤醒该会话，
 *                   不给（如单测、无会话上下文）则只记录事件。
 */
export function createWatchTools(deps: { owner?: WatchOwner } = {}): Tool[] {
  return [watchWaitTool, makeWatchStartTool(deps.owner), watchStopTool, watchListTool];
}

/** 无归属版本（仅记录事件，不唤醒） */
export const watchTools: Tool[] = createWatchTools();
