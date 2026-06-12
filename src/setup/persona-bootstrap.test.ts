import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensurePersonaFiles,
  getBootstrapStatus,
  markBootstrapComplete,
  validatePersonaFiles,
  getGlobalPersonaDir,
} from './persona-bootstrap.js';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `agent-persona-${crypto.randomUUID()}`);
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('persona bootstrap store', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('resolves the global persona directory under the config home', () => {
    const dir = getGlobalPersonaDir(tempDir);
    expect(dir).toBe(path.join(tempDir, 'prompts', 'persona'));
  });

  it('creates persona templates and reports pending before completion', async () => {
    const personaDir = path.join(tempDir, 'prompts', 'persona');

    const result = await ensurePersonaFiles(personaDir);

    expect(result.status).toBe('pending');
    expect(result.filesCreated).toEqual(expect.arrayContaining(['SOUL.md', 'IDENTITY.md', 'USER.md']));
    await expect(fs.access(path.join(personaDir, 'SOUL.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(personaDir, 'IDENTITY.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(personaDir, 'USER.md'))).resolves.toBeUndefined();
  });

  it('treats untouched templates as invalid for completion', async () => {
    const personaDir = path.join(tempDir, 'prompts', 'persona');
    await ensurePersonaFiles(personaDir);

    const validation = await validatePersonaFiles(personaDir);

    expect(validation.complete).toBe(false);
    expect(validation.missing).toEqual([]);
    expect(validation.templateFiles).toEqual(expect.arrayContaining(['IDENTITY.md', 'USER.md']));
  });

  it('marks bootstrap complete only after persona files are filled', async () => {
    const personaDir = path.join(tempDir, 'prompts', 'persona');
    await ensurePersonaFiles(personaDir);
    await fs.writeFile(path.join(personaDir, 'SOUL.md'), '# SOUL\n\n真诚、主动、有边界地协作。\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'IDENTITY.md'), '# IDENTITY\n\n- 名字: Codex\n- 类型: 编程伙伴\n- 风格: 直接、温暖\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'USER.md'), '# USER\n\n- 名字: TestUser\n- 怎么称呼: Test\n- 时区: Asia/Shanghai\n', 'utf-8');

    await markBootstrapComplete(personaDir);

    await expect(fs.access(path.join(personaDir, 'BOOTSTRAP.md'))).rejects.toThrow();
    await expect(getBootstrapStatus(personaDir)).resolves.toBe('complete');
  });

  it('does not mark bootstrap complete while persona files are still templates', async () => {
    const personaDir = path.join(tempDir, 'prompts', 'persona');
    await ensurePersonaFiles(personaDir);

    await expect(markBootstrapComplete(personaDir)).rejects.toThrow(/Persona bootstrap is incomplete/);
    await expect(getBootstrapStatus(personaDir)).resolves.toBe('pending');
  });
});
