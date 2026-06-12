import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBootstrapMode } from './bootstrap.mode.js';
import { ensurePersonaFiles, getBootstrapStatus } from '../setup/persona-bootstrap.js';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `agent-bootstrap-mode-${crypto.randomUUID()}`);
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('bootstrap mode', () => {
  let tempDir: string;
  let personaDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    personaDir = path.join(tempDir, 'prompts', 'persona');
    await ensurePersonaFiles(personaDir);
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('renders first-run guidance and remains active before completion', () => {
    const mode = createBootstrapMode(personaDir);
    const state = mode.createState({});

    const rendered = mode.renderForInjection(state);

    expect(rendered).toContain('Bootstrap');
    expect(rendered).toContain('IDENTITY.md');
    expect(mode.isComplete(state)).toBe(false);
  });

  it('rejects completion while persona files are still templates', () => {
    const mode = createBootstrapMode(personaDir);
    const state = mode.createState({});

    const result = mode.handleToolCall?.(state, 'complete', { action: 'complete' });

    expect(result?.result.allDone).toBe(false);
    expect(result?.result.progress).toContain('incomplete');
    expect(mode.isComplete(result!.newState)).toBe(false);
  });

  it('completes after persona files are filled', async () => {
    await fs.writeFile(path.join(personaDir, 'SOUL.md'), '# SOUL\n\n真诚、主动、有边界地协作。\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'IDENTITY.md'), '# IDENTITY\n\n- 名字: Codex\n- 类型: 编程伙伴\n', 'utf-8');
    await fs.writeFile(path.join(personaDir, 'USER.md'), '# USER\n\n- 名字: TestUser\n- 怎么称呼: Test\n', 'utf-8');
    const mode = createBootstrapMode(personaDir);
    const state = mode.createState({});

    const result = mode.handleToolCall?.(state, 'complete', { action: 'complete' });

    expect(result?.result.allDone).toBe(true);
    expect(mode.isComplete(result!.newState)).toBe(true);
    await expect(getBootstrapStatus(personaDir)).resolves.toBe('complete');
  });
});
