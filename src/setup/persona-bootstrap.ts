import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logging/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('persona-bootstrap');

// ─── Constants ──────────────────────────────────────────────────────

const PERSONA_STATE_DIR = '.state';
const PERSONA_STATE_FILE = 'persona-state.json';
const PERSONA_STATE_VERSION = 1;

const PERSONA_FILE_NAMES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'PartnerSoul.md',
  'PartnerMemory.md',
] as const;

export type PersonaFileName = (typeof PERSONA_FILE_NAMES)[number];
export interface PersonaState {
  version: number;
  setupCompletedAt?: string;
}

export interface PersonaFile {
  name: PersonaFileName;
  path: string;
  content?: string;
  missing: boolean;
}

export interface PersonaValidationResult {
  complete: boolean;
  missing: PersonaFileName[];
  templateFiles: PersonaFileName[];
}

export function getGlobalPersonaDir(configHome: string = path.join(os.homedir(), '.agent')): string {
  return path.join(configHome, 'prompts', 'persona');
}

export const DEFAULT_PERSONA_DIR = getGlobalPersonaDir();

// ─── Template Loading ───────────────────────────────────────────────

function loadTemplateContent(fileName: string): string {
  const possibleDirs = [
    path.join(__dirname, '..', 'prompts', 'persona'),
    path.join(process.cwd(), 'src', 'prompts', 'persona'),
    path.join(process.cwd(), 'dist', 'prompts', 'persona'),
  ];

  for (const dir of possibleDirs) {
    const filePath = path.join(dir, fileName);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
  }

  throw new Error(`Template not found: ${fileName}. Searched: ${possibleDirs.join(', ')}`);
}

// ─── State Management ────────────────────────────────────────────────

function resolveStatePath(personaDir: string): string {
  return path.join(personaDir, PERSONA_STATE_DIR, PERSONA_STATE_FILE);
}

async function readState(personaDir: string): Promise<PersonaState> {
  const statePath = resolveStatePath(personaDir);
  try {
    const raw = await fsp.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === PERSONA_STATE_VERSION) {
      return parsed as PersonaState;
    }
    return { version: PERSONA_STATE_VERSION };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { version: PERSONA_STATE_VERSION };
    }
    throw err;
  }
}

async function writeState(personaDir: string, state: PersonaState): Promise<void> {
  const stateDir = path.join(personaDir, PERSONA_STATE_DIR);
  await fsp.mkdir(stateDir, { recursive: true });
  const statePath = resolveStatePath(personaDir);
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ─── File Operations ─────────────────────────────────────────────────

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fsp.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
}

async function fileContentDiffersFromTemplate(
  filePath: string,
  template: string,
): Promise<boolean> {
  try {
    const existing = await fsp.readFile(filePath, 'utf-8');
    return existing !== template;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

// ─── Generic Prompt Sync ──────────────────────────────────────────────

/**
 * 确保内置 prompt 目录同步到 ~/.agent/prompts/{name}/。
 * 
 * 这只是一个简单的文件复制：
 * 首次安装时复制，已存在则跳过。
 * 
 * 用于 attention.md 等非 persona 的内置 prompt 文件。
 */
export async function ensureGlobalPromptDir(
  name: string,
  configHome: string = path.join(os.homedir(), '.agent'),
): Promise<string[]> {
  const targetDir = path.join(configHome, 'prompts', name);
  await fsp.mkdir(targetDir, { recursive: true });

  // 搜索源目录（与 loadTemplateContent 的搜索策略一致）
  const sourceDirs = [
    path.join(__dirname, '..', 'prompts', name),
    path.join(process.cwd(), 'src', 'prompts', name),
    path.join(process.cwd(), 'dist', 'prompts', name),
  ];

  let sourceDir: string | undefined;
  for (const dir of sourceDirs) {
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory()) { sourceDir = dir; break; }
    } catch { continue; }
  }

  if (!sourceDir) {
    logger.warn(`Source prompt directory not found: prompts/${name}. Searched: ${sourceDirs.join(', ')}`);
    return [];
  }

  const filesCreated: string[] = [];
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const created = await writeFileIfMissing(targetPath, await fsp.readFile(sourcePath, 'utf-8'));
    if (created) {
      filesCreated.push(`${name}/${entry.name}`);
    }
  }

  if (filesCreated.length > 0) {
    logger.info('Synced built-in prompt files', { dir: name, files: filesCreated });
  }

  return filesCreated;
}

// ─── Public API ──────────────────────────────────────────────────────

export async function ensurePersonaFiles(
  personaDir: string,
): Promise<{ needsSetup: boolean; filesCreated: string[]; state: PersonaState }> {
  await fsp.mkdir(personaDir, { recursive: true });

  let state = await readState(personaDir);
  const now = new Date().toISOString();

  // 自动检测：如果 persona 文件已被填写（内容 ≠ 模板）但 state 文件未反映，自动标记完成
  if (!state.setupCompletedAt) {
    try {
      const identityPath = path.join(personaDir, 'IDENTITY.md');
      const userPath = path.join(personaDir, 'USER.md');
      const identityTemplate = loadTemplateContent('IDENTITY.md');
      const userTemplate = loadTemplateContent('USER.md');
      const identityChanged = await fileContentDiffersFromTemplate(identityPath, identityTemplate);
      const userChanged = await fileContentDiffersFromTemplate(userPath, userTemplate);
      if (identityChanged || userChanged) {
        state = { ...state, setupCompletedAt: now };
        logger.info('Persona setup auto-detected as complete (files already filled)');
      }
    } catch {
      // 文件可能尚未创建 — 正常继续
    }
  }

  const alreadyComplete = !!state.setupCompletedAt;

  const filesCreated: string[] = [];

  for (const fileName of PERSONA_FILE_NAMES) {
    const filePath = path.join(personaDir, fileName);
    const template = loadTemplateContent(fileName);
    const created = await writeFileIfMissing(filePath, template);
    if (created) {
      filesCreated.push(fileName);
      logger.info('Created persona file', { file: fileName, dir: personaDir });
    }
  }

  // 二次检查：如果文件已被修改但 state 尚未记录
  if (!state.setupCompletedAt) {
    try {
      const identityPath = path.join(personaDir, 'IDENTITY.md');
      const userPath = path.join(personaDir, 'USER.md');
      const identityTemplate = loadTemplateContent('IDENTITY.md');
      const userTemplate = loadTemplateContent('USER.md');
      const identityChanged = await fileContentDiffersFromTemplate(identityPath, identityTemplate);
      const userChanged = await fileContentDiffersFromTemplate(userPath, userTemplate);
      if (identityChanged || userChanged) {
        state = { ...state, setupCompletedAt: now };
        logger.info('Persona setup detected as complete (user-modified files)');
      }
    } catch {
      // 文件可能尚未创建
    }
  }

  await writeState(personaDir, state);

  const needsSetup = !state.setupCompletedAt;
  return { needsSetup, filesCreated, state };
}

export async function ensureGlobalPersonaFiles(
  configHome?: string,
): Promise<{ needsSetup: boolean; filesCreated: string[]; state: PersonaState; personaDir: string }> {
  const personaDir = getGlobalPersonaDir(configHome);
  const result = await ensurePersonaFiles(personaDir);
  return { ...result, personaDir };
}

export async function validatePersonaFiles(personaDir: string): Promise<PersonaValidationResult> {
  const missing: PersonaFileName[] = [];
  const templateFiles: PersonaFileName[] = [];

  for (const fileName of ['SOUL.md', 'IDENTITY.md', 'USER.md'] as PersonaFileName[]) {
    const filePath = path.join(personaDir, fileName);
    let content: string;
    try {
      content = await fsp.readFile(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing.push(fileName);
        continue;
      }
      throw err;
    }

    const template = loadTemplateContent(fileName);
    if (content === template) {
      templateFiles.push(fileName);
      continue;
    }
    // 内容 ≠ 模板 → 视为已填写。不要求特定字段格式（如"名字:"等），
    // 因为 bootstrap 对话中模型可能用不同格式书写，不应因此阻塞完成标记。
  }

  return {
    complete: missing.length === 0 && templateFiles.length === 0,
    missing,
    templateFiles,
  };
}

export function validatePersonaFilesSync(personaDir: string): PersonaValidationResult {
  const missing: PersonaFileName[] = [];
  const templateFiles: PersonaFileName[] = [];

  for (const fileName of ['SOUL.md', 'IDENTITY.md', 'USER.md'] as PersonaFileName[]) {
    const filePath = path.join(personaDir, fileName);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing.push(fileName);
        continue;
      }
      throw err;
    }

    const template = loadTemplateContent(fileName);
    if (content === template) {
      templateFiles.push(fileName);
      continue;
    }
  }

  return {
    complete: missing.length === 0 && templateFiles.length === 0,
    missing,
    templateFiles,
  };
}

export async function loadPersonaFiles(personaDir: string, cwdFallback?: string): Promise<PersonaFile[]> {
  const files: PersonaFile[] = [];

  for (const fileName of PERSONA_FILE_NAMES) {
    const filePath = path.join(personaDir, fileName);
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      files.push({ name: fileName, path: filePath, content, missing: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (cwdFallback) {
          const cwdPath = path.join(cwdFallback, fileName);
          try {
            const cwdContent = await fsp.readFile(cwdPath, 'utf-8');
            files.push({ name: fileName, path: cwdPath, content: cwdContent, missing: false });
          } catch {
            files.push({ name: fileName, path: filePath, content: undefined, missing: true });
          }
        } else {
          files.push({ name: fileName, path: filePath, content: undefined, missing: true });
        }
      } else {
        throw err;
      }
    }
  }

  if (cwdFallback) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const template = loadTemplateContent(f.name);
      if (f.content === template || !f.content) {
        const cwdPath = path.join(cwdFallback, f.name);
        try {
          const cwdContent = await fsp.readFile(cwdPath, 'utf-8');
          if (cwdContent !== template) {
            files[i] = { name: f.name, path: cwdPath, content: cwdContent, missing: false };
          }
        } catch {
          // cwd version doesn't exist either — keep persona version
        }
      }
    }
  }

  return files;
}

export async function getPersonaState(personaDir: string): Promise<PersonaState> {
  return readState(personaDir);
}
