/**
 * Vitest 全局 setup —— 测试隔离（把测试写入的全局状态重定向到临时目录）。
 *
 * ① 会话目录：原会话根硬编码 `~/.agent/sessions`，导致测试（尤其 http-webhook 与
 *    装配类用例）在**用户真实目录**里建会话 —— 实测每次全量跑都新增若干裸日期目录。
 *    依赖 src/memory/session.ts 的 `HYACINTH_SESSIONS_ROOT` 覆盖点。
 *
 * ② 模型通道配置（2026-09-19 加）：`provider/model-scoped-provider.test.ts` 会构造
 *    ModelChannelRegistry 并写入夹具值（main-model / test-model / test-key）。该类的
 *    构造函数**没有路径参数**（cwd 已废弃），故原先写的是**用户真实的**
 *    ~/.agent/model-channels.json → channel-watcher 热重载 → **压缩通道 401 并静默
 *    降级为机械裁剪**（实测：单跑该文件即把真实配置覆盖成夹具值）。
 *    依赖 src/provider/model-channel-registry.ts 的 `HYACINTH_MODEL_CHANNELS_PATH` 覆盖点。
 *
 * 两者都是**生产行为不变**，只有显式设置环境变量时才改路径。
 */
import os from 'node:os';
import path from 'node:path';

const workerId = process.env.VITEST_POOL_ID ?? String(process.pid);
process.env.HYACINTH_SESSIONS_ROOT = path.join(
  os.tmpdir(),
  'hyacinth-test-sessions',
  `w${workerId}`,
);
process.env.HYACINTH_MODEL_CHANNELS_PATH = path.join(
  os.tmpdir(),
  'hyacinth-test-agent',
  `w${workerId}`,
  'model-channels.json',
);
