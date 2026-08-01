import type { ProcessState } from '../lifecycle/interface.js';

// ── 从 model-registry.ts 提取 ──

/** 模型后端类型 */
export type ModelBackend = 'llama.cpp' | 'ollama' | 'vllm' | 'lm-studio' | 'custom';

/** 模型注册条目 */
export interface ModelEntry {
  name: string;
  modelFile: string;
  modelPath: string;
  backend: ModelBackend;
  port?: number;
  host?: string;
  ctxSize?: number;
  nGpuLayers?: number;
  addedAt: string;
  enabled: boolean;
}

/** 模型注册选项 */
export interface ModelRegisterOptions {
  name: string;
  modelFile: string;
  backend?: ModelBackend;
  port?: number;
  host?: string;
  ctxSize?: number;
  nGpuLayers?: number;
}

// ── 从 model-bridge.ts 提取 ──

/** 运行中模型信息 */
export interface RunningModelInfo {
  name: string;
  modelFile: string;
  backend: string;
  port: number;
  host: string;
  state: ProcessState;
  pid: number | null;
  baseUrl: string;
}

// ── 从 llamacpp.ts 提取 ──

/** LlamaCppProvider 构造选项 */
export interface LlamaCppOptions {
  /** llama-server 地址，默认 http://127.0.0.1:8080 */
  endpoint?: string;
  /** 模型名称，默认 llama-3-8b-q4_k_m */
  model?: string;
  /** 最大输出 token 数，默认 4096 */
  maxTokens?: number;
  /** 最大上下文 token 数（用于 getCapabilities），默认 8192 */
  maxContextTokens?: number;
}