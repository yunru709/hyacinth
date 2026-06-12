import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

// ============================================================================
// 类型定义
// ============================================================================

/** Adapter 训练统计 */
export interface AdapterStats {
  epochs: number;
  finalLoss: number;
  duration: string; // 训练时长（如 "45min"）
  completedAt: string;
}

/** Adapter 信息 */
export interface AdapterInfo {
  name: string;
  filePath: string; // adapter 权重文件路径
  trainedAt: string; // ISO 时间戳
  toolNames: string[]; // 适配的工具列表
  sourceDate: string; // 训练数据来源日期
  sampleCount: number; // 训练样本数
  stats?: AdapterStats; // 训练统计
}

/** 训练选项 */
export interface TrainOptions {
  name: string; // Adapter 名称
  datasetPath: string; // 训练数据文件路径
  baseModel: string; // 基座模型路径
  toolNames: string[]; // 适配的工具
  sourceDate: string; // 数据来源日期
  sampleCount: number; // 样本数
  epochs?: number; // 默认 3
  learningRate?: number; // 默认 1e-4
  loraRank?: number;
  loraAlpha?: number;
}

/** 训练结果 */
export interface TrainResult {
  name: string;
  adapterPath: string; // 输出的 adapter 文件路径
  stats: AdapterStats;
}

/** Adapter 堆叠配置 */
export interface AdapterStackConfig {
  adapters: string[]; // Adapter 名称列表（按加载顺序）
  loraArgs: string[]; // llama-server 命令行参数
}

/** Registry 文件结构 */
export interface AdapterRegistry {
  version: number; // 当前为 1
  adapters: Record<string, AdapterInfo>;
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_EPOCHS = 3;
const DEFAULT_LEARNING_RATE = 1e-4;
const DEFAULT_CTX = 2048;
const DEFAULT_BATCH_SIZE = 4;
const STACK_DEFAULT_SCALE = 1.0;
const STACK_SUBSEQUENT_SCALE = 0.5;

// ============================================================================
// 工具函数
// ============================================================================

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 将毫秒转换为人类可读的时间字符串 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const totalMinutes = Math.round(ms / 60_000);
  const totalHours = Math.round(ms / 3_600_000);

  if (totalHours >= 1) {
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    return minutes > 0 ? `${totalHours}h${minutes}min` : `${totalHours}h`;
  }
  if (totalMinutes >= 1) {
    return `${totalMinutes}min`;
  }
  return `${totalSeconds}s`;
}

/** 获取 CPU 核心数（至少为 1） */
function getThreadCount(): number {
  return Math.max(1, cpus().length);
}

// ============================================================================
// AdapterManager
// ============================================================================

export class AdapterManager {
  private registry: Map<string, AdapterInfo> = new Map();
  private adaptersDir: string; // adapters 权重文件目录（registryPath 的父目录）

  constructor(
    private registryPath: string, // adapters/registry.json 路径
    private dataDir: string, // training_data 根目录
  ) {
    this.adaptersDir = path.dirname(this.registryPath);
  }

  // ==========================================================================
  // 公共 API
  // ==========================================================================

  /** 初始化：加载 registry */
  async init(): Promise<void> {
    await ensureDir(this.adaptersDir);
    this.registry = await this.loadRegistry();
  }

  /** 获取所有已注册的 Adapter */
  async list(): Promise<AdapterInfo[]> {
    const items = Array.from(this.registry.values());
    // 按 trainedAt 降序排列（最新的在前）
    items.sort((a, b) => b.trainedAt.localeCompare(a.trainedAt));
    return items;
  }

  /** 获取单个 Adapter 信息 */
  async get(name: string): Promise<AdapterInfo | undefined> {
    return this.registry.get(name);
  }

  /**
   * 训练一个新的 Adapter。
   *
   * 通过 child_process.spawn 调用外部 llama-finetune 命令。
   * 如果 llama-finetune 不可用，抛出明确错误。
   */
  async train(options: TrainOptions): Promise<TrainResult> {
    const {
      name,
      datasetPath,
      baseModel,
      toolNames,
      sourceDate,
      sampleCount,
      epochs = DEFAULT_EPOCHS,
      learningRate = DEFAULT_LEARNING_RATE,
      loraRank,
      loraAlpha,
    } = options;

    // 1. 验证数据集文件存在
    try {
      await fs.access(datasetPath);
    } catch {
      throw new Error(
        `Training dataset not found: ${datasetPath}. ` +
          `Please run DatasetBuilder first to generate training data.`,
      );
    }

    // 2. 确保 adapters 目录存在
    await ensureDir(this.adaptersDir);

    // 3. 输出 adapter 路径
    const adapterPath = path.join(this.adaptersDir, `${name}.gguf`);

    // 4. 构建训练命令
    const threads = getThreadCount();
    const rank = loraRank ?? 16;
    const alpha = loraAlpha ?? 16;
    const args = [
      '--model-base', baseModel,
      '--data', datasetPath,
      '--threads', String(threads),
      '--lora-out', adapterPath,
      '--epochs', String(epochs),
      '--ctx', String(DEFAULT_CTX),
      '--batch-size', String(DEFAULT_BATCH_SIZE),
      '--lora-r', String(rank),
      '--lora-alpha', String(alpha),
    ];

    // 5. 记录训练开始时间
    const startedAt = Date.now();
    const trainedAt = new Date().toISOString();

    let finalLoss = 0;

    // 6. 执行训练命令
    try {
      finalLoss = await this.executeTrainCommand(args, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Adapter training failed for "${name}": ${message}\n\n` +
          `Ensure llama-finetune is installed and built with LLAMA_LLAMAFILE=OFF. ` +
          `Command: llama-finetune ${args.join(' ')}`,
      );
    }

    // 7. 计算训练时长
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    const duration = formatDuration(durationMs);

    // 8. 构建 AdapterInfo 并写入 registry
    const info: AdapterInfo = {
      name,
      filePath: adapterPath,
      trainedAt,
      toolNames,
      sourceDate,
      sampleCount,
      stats: {
        epochs,
        finalLoss,
        duration,
        completedAt,
      },
    };

    this.registry.set(name, info);
    await this.saveRegistry();

    return {
      name,
      adapterPath,
      stats: {
        epochs,
        finalLoss,
        duration,
        completedAt,
      },
    };
  }

  /**
   * 生成 Adapter 堆叠配置。
   *
   * 生成 llama-server 的 --lora / --lora-scaled 参数。
   * 第一个 adapter 默认 scale = 1.0，后续 adapter 默认 scale = 0.5。
   */
  stack(adapters: string[]): AdapterStackConfig {
    const loraArgs: string[] = [];
    const resolved: string[] = [];

    for (let i = 0; i < adapters.length; i++) {
      const name = adapters[i];
      const info = this.registry.get(name);

      if (!info) {
        throw new Error(
          `Adapter "${name}" not found in registry. ` +
            `Available adapters: ${Array.from(this.registry.keys()).join(', ') || '(none)'}`,
        );
      }

      resolved.push(name);

      if (i === 0) {
        // 第一个 adapter 使用默认 scale
        loraArgs.push('--lora', info.filePath);
      } else {
        // 后续 adapter 使用缩放后的 scale
        loraArgs.push('--lora-scaled', info.filePath, String(STACK_SUBSEQUENT_SCALE));
      }
    }

    return { adapters: resolved, loraArgs };
  }

  /** 删除 Adapter（移除注册和文件） */
  async remove(name: string): Promise<void> {
    const info = this.registry.get(name);

    if (!info) {
      throw new Error(
        `Adapter "${name}" not found in registry. ` +
          `Available adapters: ${Array.from(this.registry.keys()).join(', ') || '(none)'}`,
      );
    }

    // 从内存 registry 中移除
    this.registry.delete(name);

    // 尝试删除 adapter 权重文件（文件不存在则忽略）
    try {
      await fs.unlink(info.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw err;
      }
      // ENOENT: 文件已不存在，忽略
    }

    // 保存更新后的 registry
    await this.saveRegistry();
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /** 读取 JSON registry 文件 */
  private async loadRegistry(): Promise<Map<string, AdapterInfo>> {
    const map = new Map<string, AdapterInfo>();

    try {
      const raw = await fs.readFile(this.registryPath, 'utf-8');
      const parsed: AdapterRegistry = JSON.parse(raw);

      if (parsed.version !== 1) {
        throw new Error(
          `Unsupported registry version: ${parsed.version}. Expected version 1.`,
        );
      }

      if (parsed.adapters && typeof parsed.adapters === 'object') {
        for (const [key, value] of Object.entries(parsed.adapters)) {
          map.set(key, value as AdapterInfo);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 文件不存在，初始化空 registry 并写入
        await this.saveEmptyRegistry();
        return map;
      }
      // JSON 解析错误等重新抛出
      throw new Error(
        `Failed to load adapter registry from "${this.registryPath}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return map;
  }

  /** 写入 JSON registry 文件 */
  private async saveRegistry(): Promise<void> {
    const registry: AdapterRegistry = {
      version: 1,
      adapters: Object.fromEntries(this.registry),
    };

    await fs.writeFile(
      this.registryPath,
      JSON.stringify(registry, null, 2) + '\n',
      'utf-8',
    );
  }

  /** 写入空 registry 文件 */
  private async saveEmptyRegistry(): Promise<void> {
    const registry: AdapterRegistry = {
      version: 1,
      adapters: {},
    };

    await fs.writeFile(
      this.registryPath,
      JSON.stringify(registry, null, 2) + '\n',
      'utf-8',
    );
  }

  /**
   * 执行 llama-finetune 训练命令。
   *
   * 通过 child_process.spawn 调用，实时监控 stdout/stderr 输出。
   * 解析输出中的 loss 信息（格式: "loss=0.342"）。
   *
   * @returns 最终 loss 值
   */
  private executeTrainCommand(args: string[], name: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn('llama-finetune', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let lastLoss = 0;
      let stderrBuffer = '';

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        // 尝试解析 loss 值: 匹配 "loss=X.XXX" 或 "loss = X.XXX"
        const lossMatch = text.match(/loss\s*[=:]\s*([\d.]+)/i);
        if (lossMatch) {
          lastLoss = parseFloat(lossMatch[1]);
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `llama-finetune command not found. ` +
                `Please build llama.cpp with LLAMA_LLAMAFILE=OFF and ensure llama-finetune is in PATH.\n\n` +
                `Build instructions:\n` +
                `  cd llama.cpp\n` +
                `  cmake -B build -DLLAMA_LLAMAFILE=OFF\n` +
                `  cmake --build build --config Release -j\n` +
                `  # The llama-finetune binary will be in build/bin/`,
            ),
          );
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(lastLoss);
        } else {
          const errorDetail = stderrBuffer.trim() || `exit code ${code}`;
          reject(
            new Error(
              `llama-finetune exited with code ${code} for adapter "${name}".\n` +
                `Details: ${errorDetail}`,
            ),
          );
        }
      });
    });
  }
}