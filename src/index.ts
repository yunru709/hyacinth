#!/usr/bin/env node
import { runCli } from './gateway/cli.js';
import { createLogger } from './logging/logger.js';

const logger = createLogger('app');
runCli().catch((err) => logger.error('Unhandled error', err instanceof Error ? err : undefined));
