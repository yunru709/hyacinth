#!/usr/bin/env node
/**
 * CLI: agent train — 训练调度器命令行接口
 *
 * 用法:
 *   agent train --on      启动调度器（开始定时检查）
 *   agent train --off     停止调度器
 *   agent train --now     立即执行一次训练
 *   agent train --status  查看调度器状态
 */

import { TrainingScheduler } from '../training/scheduler.js';
import { TrainingAggregator } from '../training/aggregator.js';
import { DatasetBuilder } from '../training/dataset.js';
import { AdapterManager } from '../training/adapter.js';
import { ModelStore } from '../training/model-store.js';
import { ConfigManager } from '../setup/config.js';
import { DataRefiner } from '../training/refiner.js';
import { RefinedDataStore } from '../training/refined-store.js';
import { AdapterBridge } from '../training/adapter-bridge.js';
import { LocalModelModule } from '../local-model/index.js';

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }

  // 初始化模块
  const sessionsDir = './sessions';
  const trainingDir = './training_data';
  const adaptersDir = './adapters';

  // 加载配置
  const configManager = new ConfigManager();
  const config = await configManager.load();
  const trainingConfig = config.training;

  const modelStore = new ModelStore('./models');
  await modelStore.scan();

  const aggregator = new TrainingAggregator(sessionsDir);
  const datasetBuilder = new DatasetBuilder(trainingDir);
  const adapterManager = new AdapterManager(`${adaptersDir}/registry.json`, trainingDir);
  await adapterManager.init();

  const refinedStore = new RefinedDataStore(process.cwd());
  const refiner = new DataRefiner();
  const localModelModule = LocalModelModule.getInstance();
  if (!localModelModule.isInitialized()) {
    localModelModule.initialize(process.cwd());
  }
  const modelBridge = localModelModule.getBridge();
  const adapterBridge = new AdapterBridge(modelBridge, adaptersDir);

  const scheduler = new TrainingScheduler({
    aggregator,
    datasetBuilder,
    adapterManager,
    modelStore,
    config: trainingConfig,
    refiner,
    refinedStore,
    adapterBridge,
    cwd: process.cwd(),
  });

  const cmd = args[0];

  switch (cmd) {
    case '--on': {
      // 持久化 enabled 状态
      const cfg = await configManager.load();
      if (!cfg.training) {
        cfg.training = { enabled: true, scheduleTime: '03:00', checkIntervalMs: 600000, minSamples: 10, baseModel: 'models/llama-3-8b-q4_k_m.gguf' };
      } else {
        cfg.training.enabled = true;
      }
      await configManager.save(cfg);
      scheduler.enable();
      console.log('[TrainingScheduler] Scheduler started.');
      console.log(`  Next run: ${scheduler.getStatus().nextScheduled}`);
      break;
    }

    case '--off': {
      // 持久化 disabled 状态
      const cfg = await configManager.load();
      if (!cfg.training) {
        cfg.training = { enabled: false, scheduleTime: '03:00', checkIntervalMs: 600000, minSamples: 10, baseModel: 'models/llama-3-8b-q4_k_m.gguf' };
      } else {
        cfg.training.enabled = false;
      }
      await configManager.save(cfg);
      scheduler.disable();
      console.log('[TrainingScheduler] Scheduler stopped.');
      break;
    }

    case '--now': {
      console.log('[TrainingScheduler] Triggering training now...');
      try {
        const result = await scheduler.triggerNow();
        console.log(`  Status: ${result.run.status}`);
        console.log(`  Samples: ${result.run.sampleCount}`);
        console.log(`  Summary: ${result.summary}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`  Failed: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case '--status': {
      const status = scheduler.getStatus();
      console.log('=== Training Scheduler Status ===');
      console.log(`  Running:      ${status.running ? 'yes' : 'no'}`);
      console.log(`  Enabled:      ${status.enabled ? 'yes' : 'no'}`);
      console.log(`  Schedule:     ${status.scheduleTime}`);
      console.log(`  Next run:     ${status.nextScheduled}`);
      console.log(`  Can train:    ${status.canTrain ? 'yes' : 'no'}`);
      if (status.skipReason) {
        console.log(`  Skip reason:  ${status.skipReason}`);
      }
      if (status.isTraining) {
        console.log(`  Training:     in progress`);
      }
      if (status.lastRun) {
        console.log(`  Last run:     ${status.lastRun.startedAt} → ${status.lastRun.completedAt ?? 'in progress'}`);
        console.log(`  Last status:  ${status.lastRun.status}`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

// ============================================================================
// 帮助信息
// ============================================================================

function showHelp(): void {
  console.log(`
Agent Training CLI

Usage:
  agent train --on        Start scheduler (auto-start at scheduled time)
  agent train --off       Stop scheduler
  agent train --now       Trigger training immediately
  agent train --status    Show scheduler status
  agent train --help      Show this help
`);
}

main().catch((err) => {
  console.error('[Training CLI] Error:', err);
  process.exit(1);
});