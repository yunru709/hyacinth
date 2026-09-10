import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';
const logger = createLogger('session-allowlist');

export interface SessionAllowlistData {
  allowedTools: string[];
  allowedCommands: string[];
}

const EMPTY_DATA: SessionAllowlistData = { allowedTools: [], allowedCommands: [] };

export async function load(sessionDir: string): Promise<SessionAllowlistData> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, 'allowlist.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      allowedCommands: Array.isArray(parsed.allowedCommands) ? parsed.allowedCommands : [],
    };
  } catch {
    return { ...EMPTY_DATA };
  }
}

export async function save(sessionDir: string, data: SessionAllowlistData): Promise<void> {
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'allowlist.json'),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.warn('Failed to save allowlist', { sessionDir, error: String(err) });
  }
}

export async function addTool(sessionDir: string, toolName: string): Promise<void> {
  const data = await load(sessionDir);
  if (!data.allowedTools.includes(toolName)) {
    data.allowedTools.push(toolName);
  }
  await save(sessionDir, data);
}

export async function addCommand(sessionDir: string, command: string): Promise<void> {
  const data = await load(sessionDir);
  if (!data.allowedCommands.includes(command)) {
    data.allowedCommands.push(command);
  }
  await save(sessionDir, data);
}

export async function isToolAllowed(sessionDir: string, toolName: string): Promise<boolean> {
  const data = await load(sessionDir);
  return data.allowedTools.includes(toolName);
}

export async function isCommandAllowed(sessionDir: string, command: string): Promise<boolean> {
  const data = await load(sessionDir);
  return data.allowedCommands.includes(command);
}
