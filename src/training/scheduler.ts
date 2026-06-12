import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TrainingAggregator } from './aggregator.js';
import type { DatasetBuilder } from './dataset.js';
import type { AdapterManager } from './adapter.js';
import type { StatsManager } from '../memory/stats.js';
import type { ModelStore } from './model-store.js';
import type { ProviderRouter } from '../provider/router.js';
import type { TrainingConfig } from '../setup/config.js';
import { formatDate } from '../utils/misc.js';
import type { DataRefiner } from './refiner.js';
import type { RefinedDataStore, RefinedSample } from './refined-store.js';
import type { AdapterBridge } from './adapter-bridge.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface TrainingSchedulerOptions {
  cwd: string;
  aggregator: TrainingAggregator;
  datasetBuilder: DatasetBuilder;
  adapterManager: AdapterManager;
  refiner: DataRefiner;
  refinedStore: RefinedDataStore;
  adapterBridge: AdapterBridge;
  statsManager?: StatsManager;
  globalDir?: string;
  scheduleTime?: string;
  baseModel?: string;
  enabled?: boolean;
  checkIntervalMs?: number;
  modelStore?: ModelStore;
  providerRouter?: ProviderRouter;
  config?: TrainingConfig;
}

export interface SchedulerStatus {
  running: boolean;
  enabled: boolean;
  scheduleTime: string;
  nextScheduled: string;
  lastRun?: TrainingRunRecord;
  isTraining: boolean;
  canTrain: boolean;
  skipReason?: string;
}

export interface TrainingRunRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: TrainingStep[];
  sampleCount: number;
  adapterTrained: string[];
  error?: string;
}

export interface TrainingStep {
  name: string;
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  details?: Record<string, unknown>;
}

export interface TrainingRunResult {
  run: TrainingRunRecord;
  summary: string;
}

// ============================================================================
// 错误类型
// ============================================================================

/** 训练被用户取消时抛出的异常 */
export class TrainingCancelledError extends Error {
  constructor(message = 'Training was cancelled') {
    super(message);
    this.name = 'TrainingCancelledError';
  }
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_CONFIG_CONTENT = JSON.stringify(
  { scheduleTime: '03:00', baseModel: 'models/llama-3-8b-q4_k_m.gguf' },
  null,
  2,
);

function loadTrainingDefaults(
  cwd: string,
): { scheduleTime: string; baseModel: string } {
  const filePath = path.join(cwd, '.agent', 'training.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      scheduleTime: parsed.scheduleTime || '03:00',
      baseModel: parsed.baseModel || 'models/llama-3-8b-q4_k_m.gguf',
    };
  } catch {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, DEFAULT_CONFIG_CONTENT, 'utf-8');
    return {
      scheduleTime: '03:00',
      baseModel: 'models/llama-3-8b-q4_k_m.gguf',
    };
  }
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const MAX_HISTORY = 10;

// ============================================================================
// 工具函数
// ============================================================================

// formatDate 已迁移至 src/utils/misc.js

/** 获取当前时间的 HH:MM 字符串 */
function getCurrentTimeKey(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 获取指定时间的 HH:MM 字符串 */
function getTimeKey(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 根据 scheduleTime 字符串计算下一次触发时间。
 * - 如果今天的 scheduleTime 还未到达，返回今天的 scheduleTime
 * - 如果今天的 scheduleTime 已过，返回明天的 scheduleTime
 */
function computeNextScheduled(scheduleTime: string): Date {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  const now = new Date();

  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);

  if (candidate <= now) {
    // 今天时间已过，设为明天
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}

/** 计算两个 Date 之间的人类可读时间差 */
function formatElapsed(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const totalMinutes = Math.round(ms / 60_000);
  const totalHours = Math.round(ms / 3_600_000);

  if (totalHours >= 1) {
    const remainingMinutes = Math.round((ms % 3_600_000) / 60_000);
    return remainingMinutes > 0 ? `${totalHours}h${remainingMinutes}min` : `${totalHours}h`;
  }
  if (totalMinutes >= 1) {
    return `${totalMinutes}min`;
  }
  const totalSeconds = Math.round(ms / 1000);
  return `${totalSeconds}s`;
}

/** 创建新的 TrainingStep */
function createStep(name: string): TrainingStep {
  return {
    name,
    startedAt: new Date().toISOString(),
    status: 'pending',
  };
}

/** 标记 step 完成 */
function completeStep(step: TrainingStep, details?: Record<string, unknown>): void {
  step.status = 'completed';
  step.completedAt = new Date().toISOString();
  if (details) {
    step.details = details;
  }
}

/** 标记 step 失败 */
function failStep(step: TrainingStep, error: string): void {
  step.status = 'failed';
  step.completedAt = new Date().toISOString();
  step.details = { error };
}

// ============================================================================
// TrainingScheduler
// ============================================================================

export class TrainingScheduler {
  private aggregator: TrainingAggregator;
  private datasetBuilder: DatasetBuilder;
  private adapterManager: AdapterManager;
  private refiner: DataRefiner;
  private refinedStore: RefinedDataStore;
  private adapterBridge: AdapterBridge;
  private statsManager?: StatsManager;
  private globalDir?: string;
  private scheduleTime: string;
  private baseModel: string;
  private enabled: boolean;
  private checkIntervalMs: number;
  private minSamples: number;
  private modelStore?: ModelStore;
  private providerRouter?: ProviderRouter;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private nextScheduled: Date;
  private isTraining = false;
  private cancelled = false;
  private history: TrainingRunRecord[] = [];
  private lastRun?: TrainingRunRecord;
  private running = false;

  constructor(options: TrainingSchedulerOptions) {
    const defaults = loadTrainingDefaults(options.cwd);

    this.aggregator = options.aggregator;
    this.datasetBuilder = options.datasetBuilder;
    this.adapterManager = options.adapterManager;
    this.refiner = options.refiner;
    this.refinedStore = options.refinedStore;
    this.adapterBridge = options.adapterBridge;
    this.statsManager = options.statsManager;
    this.globalDir = options.globalDir;
    this.scheduleTime = options.config?.scheduleTime ?? options.scheduleTime ?? defaults.scheduleTime;
    this.baseModel = options.config?.baseModel ?? options.baseModel ?? defaults.baseModel;
    this.enabled = options.config?.enabled ?? options.enabled ?? false;
    this.checkIntervalMs = options.config?.checkIntervalMs ?? options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.minSamples = options.config?.minSamples ?? 10;
    this.modelStore = options.modelStore;
    this.providerRouter = options.providerRouter;

    this.nextScheduled = computeNextScheduled(this.scheduleTime);
  }

  // ==========================================================================
  // 公共 API
  // ==========================================================================

  /** 启动定时调度器（开始定时检查） */
  start(): void {
    if (!this.enabled) {
      // disabled is the default — not an error, don't log
      return;
    }

    if (this.running) {
      console.log('[TrainingScheduler] Scheduler is already running.');
      return;
    }

    this.running = true;
    console.log(
      `[TrainingScheduler] Scheduler started. ` +
        `Next training at: ${this.nextScheduled.toISOString()}`,
    );

    this.intervalId = setInterval(() => {
      this.checkAndRun();
    }, this.checkIntervalMs);
  }

  /** 停止定时调度器 */
  stop(): void {
    if (!this.running) return;  // 已停止，忽略重复调用

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log('[TrainingScheduler] Scheduler stopped.');
  }

  /** 启用调度器（设置 enabled 为 true，若心跳未启动则启动） */
  enable(): void {
    this.enabled = true;
    if (!this.intervalId) { this.start(); }
  }

  /** 禁用调度器（设置 enabled 为 false，若心跳运行中则停止） */
  disable(): void {
    this.enabled = false;
    if (this.intervalId) { this.stop(); }
  }

  /** 设置 enabled 状态 */
  setEnabled(v: boolean): void {
    if (v) this.enable(); else this.disable();
  }

  /** 设置调度时间并重新计算下一次触发时间 */
  setScheduleTime(time: string): void {
    this.scheduleTime = time;
    this.nextScheduled = computeNextScheduled(time);
  }

  /** 获取调度器运行状态 */
  getStatus(): SchedulerStatus {
    const precondition = this.canTrain();
    return {
      running: this.running,
      enabled: this.enabled,
      scheduleTime: this.scheduleTime,
      nextScheduled: this.nextScheduled.toISOString(),
      lastRun: this.lastRun,
      isTraining: this.isTraining,
      canTrain: precondition.ok,
      skipReason: precondition.reason,
    };
  }

  /** 取消当前正在进行的训练流程 */
  cancelTraining(): void {
    this.cancelled = true;
    console.log('[TrainingScheduler] Training cancelled by user.');
  }

  /** 立即触发一次训练流程（无论当前时间） */
  async triggerNow(): Promise<TrainingRunResult> {
    const precondition = this.canTrain();
    if (!precondition.ok) {
      const run: TrainingRunRecord = {
        id: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        status: 'failed',
        steps: [],
        sampleCount: 0,
        adapterTrained: [],
        error: `Precondition not met: ${precondition.reason}`,
      };
      this.history.push(run);
      throw new Error(`Cannot train: ${precondition.reason}`);
    }
    return this.runTraining();
  }

  /** 获取最近的训练运行记录 */
  getHistory(): TrainingRunRecord[] {
    return [...this.history];
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /** 检查是否满足训练前置条件：同时有本地模型和在线 Provider */
  private canTrain(): { ok: boolean; reason?: string } {
    // 检查本地模型
    if (!this.modelStore || !this.modelStore.hasModels()) {
      return { ok: false, reason: 'no local model available' };
    }

    // 检查在线 Provider
    if (!this.providerRouter) {
      return { ok: false, reason: 'no online provider available (ProviderRouter not configured)' };
    }

    const providerNames = this.providerRouter.list();
    const hasOnline = providerNames.some((name) => {
      const p = this.providerRouter!.get(name);
      return p && p.getProviderType() !== 'llamacpp' && p.getProviderType() !== 'local';
    });

    if (!hasOnline) {
      return { ok: false, reason: 'no online provider available' };
    }

    return { ok: true };
  }

  /**
   * 定时检查：当前时间是否到达 nextScheduled。
   * 只比较小时和分钟（忽略秒），避免错过窗口。
   */
  private checkAndRun(): void {
    if (this.isTraining) {
      return;
    }

    const currentKey = getCurrentTimeKey();
    const scheduledKey = getTimeKey(this.nextScheduled);

    if (currentKey >= scheduledKey) {
      const precondition = this.canTrain();
      if (!precondition.ok) {
        console.log(`[TrainingScheduler] Skipped: ${precondition.reason}.`);
        // 仍然推至明天
        this.nextScheduled = computeNextScheduled(this.scheduleTime);
        return;
      }
      console.log(
        `[TrainingScheduler] ${currentKey} - Starting daily training...`,
      );
      this.runTraining().catch((err) => {
        console.error('[TrainingScheduler] Training run failed:', err);
      });
    }
  }

  private async runTraining(): Promise<TrainingRunResult> {
    const run: TrainingRunRecord = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: [],
      sampleCount: 0,
      adapterTrained: [],
    };

    this.isTraining = true;
    const startedAt = new Date();
    let refinedSamples: RefinedSample[] = [];

    try {
      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step1 = createStep('aggregate');
      run.steps.push(step1);
      step1.status = 'running';

      console.log('[TrainingScheduler] Step 1/6: Aggregating data...');

      const date = formatDate();
      const aggregation = await this.aggregator.extractDailyData(date);

      await this.aggregator.generateDailySummary(aggregation);

      const turnCount = aggregation.turns.length;
      const sessionCount = aggregation.sessions.length;

      completeStep(step1, { turnCount, sessionCount, uniqueTools: aggregation.uniqueTools });
      console.log(
        `[TrainingScheduler] Step 1/6: Aggregating data... ` +
          `OK (${turnCount} turns from ${sessionCount} sessions)`,
      );

      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step1_5 = createStep('refine');
      run.steps.push(step1_5);
      step1_5.status = 'running';

      console.log('[TrainingScheduler] Step 2/6: Refining data...');

      try {
        const onlineProvider = this.providerRouter
          ? this.providerRouter
              .list()
              .map((name) => this.providerRouter!.get(name))
              .find(
                (p) =>
                  p &&
                  p.getProviderType() !== 'llamacpp' &&
                  p.getProviderType() !== 'local',
              )
          : undefined;

        if (onlineProvider) {
          refinedSamples = await this.refiner.refine(aggregation.turns, onlineProvider);
        }

        completeStep(step1_5, { refinedCount: refinedSamples.length });
        console.log(
          `[TrainingScheduler] Step 2/6: Refining data... ` +
            `OK (${refinedSamples.length} refined samples)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failStep(step1_5, message);
        console.error(`[TrainingScheduler] Step 2/6: Refining data... FAILED - ${message}`);
      }

      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step1_6 = createStep('save_refined');
      run.steps.push(step1_6);
      step1_6.status = 'running';

      console.log('[TrainingScheduler] Step 3/6: Saving refined data...');

      try {
        if (refinedSamples.length > 0) {
          const versions = await this.refinedStore.listVersions();
          const nextVersion = versions.length > 0 ? Math.max(...versions) + 1 : 1;
          await this.refinedStore.save(nextVersion, refinedSamples);
        }
        completeStep(step1_6, { savedCount: refinedSamples.length });
        console.log(
          `[TrainingScheduler] Step 3/6: Saving refined data... ` +
            `OK (${refinedSamples.length} samples saved)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failStep(step1_6, message);
        console.error(`[TrainingScheduler] Step 3/6: Saving refined data... FAILED - ${message}`);
      }

      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step2 = createStep('build_dataset');
      run.steps.push(step2);
      step2.status = 'running';

      console.log('[TrainingScheduler] Step 4/6: Building replay dataset...');

      const toolSampleCounts: Record<string, number> = {};
      const toolDatasetPaths: Record<string, string> = {};

      try {
        const replaySamples = await this.datasetBuilder.buildReplayDataset(
          refinedSamples,
          this.refinedStore,
        );

        for (const toolName of aggregation.uniqueTools) {
          const adapterResult = await this.datasetBuilder.buildAdapterDataset(
            aggregation.turns,
            toolName,
            date,
          );
          toolSampleCounts[toolName] = adapterResult.sampleCount;
          toolDatasetPaths[toolName] = adapterResult.filePath;
        }

        run.sampleCount = replaySamples.length;

        completeStep(step2, {
          replaySamples: replaySamples.length,
          toolSampleCounts,
        });
        console.log(
          `[TrainingScheduler] Step 4/6: Building replay dataset... ` +
            `OK (${replaySamples.length} replay samples)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failStep(step2, message);
        console.error(`[TrainingScheduler] Step 4/6: Building replay dataset... FAILED - ${message}`);
      }

      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step3 = createStep('train_adapters');
      run.steps.push(step3);
      step3.status = 'running';

      const qualifiedTools = Object.entries(toolSampleCounts)
        .filter(([, count]) => count >= this.minSamples)
        .map(([name]) => name);

      if (qualifiedTools.length === 0) {
        console.log(
          `[TrainingScheduler] Step 5/6: Training adapters... ` +
            `SKIP (no tools with >= ${this.minSamples} samples)`,
        );
        completeStep(step3, { trained: [], skipped: 'No tools met minimum sample threshold' });
      } else {
        console.log(
          `[TrainingScheduler] Step 5/6: Training adapters... ` +
            `(${qualifiedTools.length} candidates: ${qualifiedTokens(qualifiedTools)})`,
        );

        const trained: string[] = [];

        for (const toolName of qualifiedTools) {
          const datasetPath = toolDatasetPaths[toolName];

          try {
            await this.adapterManager.train({
              name: toolName,
              datasetPath,
              baseModel: this.baseModel,
              toolNames: [toolName],
              sourceDate: date,
              sampleCount: toolSampleCounts[toolName],
              loraRank: 16,
              loraAlpha: 16,
            });
            trained.push(toolName);
            console.log(`[TrainingScheduler]   - ${toolName}: trained`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[TrainingScheduler]   - ${toolName}: FAILED - ${message}`);
          }
        }

        run.adapterTrained = trained;
        completeStep(step3, {
          trained,
          total: qualifiedTokens(qualifiedTools),
          sampleCounts: toolSampleCounts,
        });
        console.log(
          `[TrainingScheduler] Step 5/6: Training adapters... ` +
            `OK (${trainedTokens(trained)})`,
        );
      }

      if (this.cancelled) {
        this.cancelled = false;
        this.isTraining = false;
        throw new TrainingCancelledError();
      }

      const step4 = createStep('load_adapters');
      run.steps.push(step4);
      step4.status = 'running';

      console.log('[TrainingScheduler] Step 6/6: Loading adapters...');

      try {
        const loaded: string[] = [];
        for (const toolName of run.adapterTrained) {
          try {
            const success = await this.adapterBridge.loadAdapter(toolName);
            if (success) {
              loaded.push(toolName);
              console.log(`[TrainingScheduler]   - ${toolName}: loaded`);
            } else {
              console.warn(`[TrainingScheduler]   - ${toolName}: load returned false`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[TrainingScheduler]   - ${toolName}: FAILED - ${message}`);
          }
        }
        completeStep(step4, { loaded });
        console.log(
          `[TrainingScheduler] Step 6/6: Loading adapters... ` +
            `OK (${loaded.length} loaded)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failStep(step4, message);
        console.error(`[TrainingScheduler] Step 6/6: Loading adapters... FAILED - ${message}`);
      }

      run.status = 'completed';
      run.completedAt = new Date().toISOString();

      const elapsed = formatElapsed(startedAt, new Date());
      console.log(`[TrainingScheduler] Training complete in ${elapsed}.`);

      await this.recordStats(run);

      this.lastRun = run;
      this.addToHistory(run);

      this.nextScheduled = computeNextScheduled(this.scheduleTime);
      console.log(
        `[TrainingScheduler] Next training scheduled at: ${this.nextScheduled.toISOString()}`,
      );

      return {
        run,
        summary: this.buildSummary(run, elapsed),
      };
    } catch (err) {
      if (err instanceof TrainingCancelledError) {
        console.log('[TrainingScheduler] Training cancelled by user.');
        run.status = 'cancelled' as TrainingRunRecord['status'];
        run.completedAt = new Date().toISOString();
        run.error = err.message;

        // 标记当前正在运行的 step
        for (const step of run.steps) {
          if (step.status === 'running') {
            step.status = 'failed';
            step.completedAt = new Date().toISOString();
            step.details = { error: err.message };
          }
        }

        this.lastRun = run;
        this.addToHistory(run);

        return {
          run,
          summary: err.message,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      console.error(`[TrainingScheduler] Training failed: ${message}`);

      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.error = message;

      // 标记当前正在运行的 step 为失败
      for (const step of run.steps) {
        if (step.status === 'running') {
          failStep(step, message);
        }
      }

      this.lastRun = run;
      this.addToHistory(run);

      return {
        run,
        summary: `Training failed: ${message}`,
      };
    } finally {
      this.isTraining = false;
    }
  }

  /** 写入 StatsManager 统计 */
  private async recordStats(run: TrainingRunRecord): Promise<void> {
    if (!this.statsManager || !this.globalDir) {
      return;
    }

    try {
      // stats.json 中维护全局训练统计字段
      const existing = await this.statsManager.get(this.globalDir);
      const existingRecord = existing as unknown as Record<string, unknown>;
      const trainingRunsTotal =
        (existingRecord.training_runs_total as number) ?? 0;
      const trainingSamplesTotal =
        (existingRecord.training_samples_total as number) ?? 0;

      await this.statsManager.update(this.globalDir, {
        ...existing,
        last_training_run: run.completedAt ?? run.startedAt,
        training_runs_total: trainingRunsTotal + 1,
        training_samples_total: trainingSamplesTotal + run.sampleCount,
      } as Parameters<StatsManager['update']>[1]);
    } catch (err) {
      console.error(
        '[TrainingScheduler] Failed to write stats:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** 追加训练记录到历史列表（保留最近 MAX_HISTORY 条） */
  private addToHistory(run: TrainingRunRecord): void {
    this.history.push(run);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  /** 构建训练结果摘要 */
  private buildSummary(run: TrainingRunRecord, elapsed: string): string {
    const turnCount = run.sampleCount;
    const adapterCount = run.adapterTrained.length;
    return (
      `Daily training completed in ${elapsed}. ` +
      `${turnCount} samples generated, ` +
      `${adapterCount} adapter(s) trained${adapterCount > 0 ? ` (${run.adapterTrained.join(', ')})` : ''}.`
    );
  }
}

// ============================================================================
// 日志格式化辅助函数
// ============================================================================

function qualifiedTokens(tools: string[]): string {
  return tools.join(', ');
}

function trainedTokens(tools: string[]): string {
  if (tools.length === 0) {
    return 'none';
  }
  return tools.join(', ');
}