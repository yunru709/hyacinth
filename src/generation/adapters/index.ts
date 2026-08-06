/**
 * 适配器聚合文件 — 收集所有内置适配器的 meta（自描述）。
 *
 * 加新厂商流程（只有两步，registry/service/interface 零改动）：
 *   1. 新建 adapters/xxx.ts：实现 GenerationProvider + 导出 `meta: AdapterMeta`
 *   2. 在本文件 import 一行 + 加入 BUILTIN_ADAPTERS 数组
 *
 * registry 从 BUILTIN_ADAPTERS 自动注册，配置里 providers[].type 引用 meta.type。
 */
import type { AdapterMeta } from '../interface.js';
import { meta as volcengine } from './volcengine.js';

export const BUILTIN_ADAPTERS: AdapterMeta[] = [
  volcengine,
  // —— 新厂商在这里加一行（示例）——
  // kling,          // adapters/kling.ts 导出 meta
  // minimax,        // adapters/minimax.ts 导出 meta
  // wanxiang,       // adapters/wanxiang.ts 导出 meta（通义万相）
];
