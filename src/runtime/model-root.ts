/**
 * 模型根目录解析 — STT / TTS / 本地模型共用的存储位置唯一真源。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量 HYACINTH_MODELS_DIR（绿色包/无配置环境的最直接通道）
 *   2. 运行时配置 models.root（config.json，经 config.set 持久化 —— UI 设置页写这里）
 *   3. 默认 ~/.agent/models
 *
 * 为什么单独成模块而不是塞进 stt/tts 各自：位置是**跨引擎共享**的策略
 * （换盘一次管全部）；且两个引擎都是零依赖的普通类，注入 RuntimeConfigCenter
 * 反而引入生命周期耦合。config.json 直读 + mtime 缓存，改配置即时生效
 * （configCenter.set 的 save 也会落同一份文件）。
 *
 * 语义：只影响**之后**的下载与加载查找；已下载到旧目录的文件不自动迁移
 * （UI 提示手动移动，或删除后按新位置重下）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 纯解析（可测）：不碰文件系统。 */
export function resolveModelRoot(envValue: string | undefined, configValue: string | undefined, home: string): string {
  const fromEnv = (envValue ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromCfg = (configValue ?? '').trim();
  if (fromCfg) return path.resolve(fromCfg);
  return path.join(home, '.agent', 'models');
}

function readConfigRoot(): string | undefined {
  try {
    const file = path.join(os.homedir(), '.agent', 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { models?: { root?: unknown } };
    return typeof raw.models?.root === 'string' ? raw.models.root : undefined;
  } catch {
    return undefined;   // 配置缺失/损坏 ⇒ 默认位置
  }
}

/** 当前生效的模型根目录（每次现读 config.json —— 调用频率低，不值得缓存失效逻辑） */
export function getModelRoot(): string {
  return resolveModelRoot(process.env.HYACINTH_MODELS_DIR, readConfigRoot(), os.homedir());
}
