import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ModeManager } from '../modes/manager.js';
import { createBootstrapMode } from '../modes/bootstrap.mode.js';
import { ensurePersonaFiles, getBootstrapStatus } from '../setup/persona-bootstrap.js';
import { createBootstrapMarkTool } from './bootstrap.js';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `agent-bootstrap-tool-${crypto.randomUUID()}`);
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('bootstrap_mark tool', () => {
  let tempDir: string;
  let personaDir: string;
  let manager: ModeManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    personaDir = path.join(tempDir, 'prompts', 'persona');
    await ensurePersonaFiles(personaDir);
    manager = new ModeManager();
    manager.register(createBootstrapMode(personaDir));
    manager.activate('bootstrap');
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('records progress while bootstrap is active', async () => {
    const tool = createBootstrapMarkTool(manager);

    const result = await tool.execute({ action: 'progress', message: 'Collected user name.' });

    expect(result).toContain('[bootstrap]');
    expect(result).toContain('Collected user name.');
    expect(manager.isActive()).toBe(true);
  });

  it('keeps bootstrap active when completion validation fails', async () => {
    const tool = createBootstrapMarkTool(manager);

    const result = await tool.execute({ action: 'complete' });

    expect(result).toContain('Bootstrap incomplete');
    expect(manager.isActive()).toBe(true);
  });

  it('marks global state complete and deactivates bootstrap after validation passes', async () => {
    await fs.writeFile(path.join(personaDir, 'SOUL.md'), '# SOUL\n\n真诚、主动、有边界地协作。\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'IDENTITY.md'), '# IDENTITY\n\n- 名字: Codex\n- 类型: 编程伙伴\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'USER.md'), '# USER\n\n- 名字: TestUser\n- 怎么称呼: Test\n', 'utf-8');
    const tool = createBootstrapMarkTool(manager);

    const result = await tool.execute({ action: 'complete' });

    expect(result).toContain('bootstrap 模式全部完成');
    expect(manager.isActive()).toBe(false);
    await expect(getBootstrapStatus(personaDir)).resolves.toBe('complete');
  });
});
