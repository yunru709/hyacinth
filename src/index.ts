#!/usr/bin/env node
import { bootstrapSecurity } from './kernel/security/index.js';

// 安全内核必须先于一切业务模块安装：index.ts 只静态 import 内核，
// 其余全部走动态 import —— 保证 ESM 对内建模块的具名导入在守卫变异
// 之后才创建命名空间（scripts/security-spike.mjs 实测结论）。
bootstrapSecurity();

const { createLogger } = await import('./logging/logger.js');
const { runCli } = await import('./gateway/cli.js');

const logger = createLogger('app');
runCli().catch((err) => logger.error('Unhandled error', err instanceof Error ? err : undefined));
