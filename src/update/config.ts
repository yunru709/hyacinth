import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UpdateConfig } from './types.js';

const CONFIG_PATH = path.join(os.homedir(), '.agent', 'update.json');

export function loadConfig(): UpdateConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: UpdateConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export { CONFIG_PATH };
