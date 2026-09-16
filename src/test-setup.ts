/**
 * Vitest 全局 setup —— 测试隔离（会话目录重定向）。
 *
 * 背景：会话根目录原先硬编码 `~/.agent/sessions`，导致测试（尤其 http-webhook 与
 * 装配类用例）会在**用户真实目录**里建会话目录 —— 实测每次全量跑都会新增若干裸日期
 * 目录（meta.json 的 projectKey 指向 Temp 下的 ui-webhook-xxxx），长期累积成垃圾。
 *
 * 做法：把 sessions 根目录重定向到临时目录，按 worker 再分一层，避免并行用例互相干扰。
 * 依赖 src/memory/session.ts 的 `HYACINTH_SESSIONS_ROOT` 覆盖点 —— 生产行为不变，
 * 只有显式设置该环境变量时才改路径。
 */
import os from 'node:os';
import path from 'node:path';

const workerId = process.env.VITEST_POOL_ID ?? String(process.pid);
process.env.HYACINTH_SESSIONS_ROOT = path.join(
  os.tmpdir(),
  'hyacinth-test-sessions',
  `w${workerId}`,
);
