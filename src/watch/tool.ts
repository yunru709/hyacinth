/**
 * Watch 工具层（2026-10-29）
 *
 * 四个工具，对应两种形态：
 *   watch_wait   —— 同步等待（阻塞到变化/超时），适合「盯着等一两分钟」
 *   watch_start  —— 后台挂起（立即返回），适合「可能几小时后才发生」
 *   watch_list   —— 列出在跑的监控 + 最近事件
 *   watch_stop   —— 停止某个监控
 *
 * 事件出口：当前实现把事件推进一个环形缓冲，由 watch_list 读取展示。
 * 真正的「唤醒会话」需要接 SessionWakePort（见 docs/watch.md 阶段 4），
 * 届时只需替换 getService() 里的 onEvent，工具签名不用变。
 */

import type { Tool } from '../tools/interface.js';
import { createDefaultProbeRegistry } from './probes/index.js';
import type { WatchSpec } from './types.js';
import { WatchService, type WatchEvent } from './watch-service.js';
import { waitForChange } from './wait.js';

/** 同步等待上限：框架侧工具超时是 300s，但阻塞太久会卡住整个回合，取 90s 封顶 */
const MAX_WAIT_MS = 90_000;
const DEFAULT_WAIT_MS = 25_000;
const RECENT_EVENT_LIMIT = 50;

const recentEvents: WatchEvent[] = [];

function pushEvent(event: WatchEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > RECENT_EVENT_LIMIT) recentEvents.shift();
}

let service: WatchService | null = null;

function getService(): WatchService {
  if (!service) {
    service = new WatchService({
      registry: createDefaultProbeRegistry(),
      onEvent: (event) => pushEvent(event),
    });
  }
  return service;
}

/** 供后续接入唤醒会话时替换 */
export function setWatchEventHandler(handler: (event: WatchEvent) => void | Promise<void>): void {
  if (service) service.disposeAll();
  service = new WatchService({
    registry: createDefaultProbeRegistry(),
    onEvent: async (event) => {
      pushEvent(event);
      await handler(event);
    },
  });
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

export const watchWaitTool: Tool = {
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

export const watchStartTool: Tool = {
  name: 'watch_start',
  description:
    '启动一个后台监控，立即返回 watchId（不阻塞）。条件成立时记录事件，' +
    '用 watch_list 查看。适合「可能要等很久」的场合。' +
    '注意每个监控触发后会进入冷却期（默认 30 秒）再继续，避免事件风暴。',
  inputSchema: {
    type: 'object',
    properties: {
      ...SPEC_PROPS,
      note: { type: 'string', description: '备注，便于在 watch_list 里辨认' },
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
      });
      return JSON.stringify({ ok: true, watch: info });
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }
  },
};

export const watchStopTool: Tool = {
  name: 'watch_stop',
  description: '停止一个后台监控。',
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

export const watchListTool: Tool = {
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

export const watchTools: Tool[] = [
  watchWaitTool,
  watchStartTool,
  watchStopTool,
  watchListTool,
];
