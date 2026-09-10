import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { GlobTool } from './glob.js';
import { BashTool } from './bash.js';
import { MultiEditTool } from './multi-edit.js';
import { recordFileRead } from './file-tracker.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './executor.js';
import type { Tool } from './interface.js';

// ─── Test helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return path.join(os.tmpdir(), `agent-test-${crypto.randomUUID()}`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

// ─── ReadTool ──────────────────────────────────────────────────────────

describe('ReadTool', () => {
  const tool = new ReadTool();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('reads a file and returns content with line numbers', async () => {
    const filePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3', 'utf-8');

    const result = await tool.execute({ file_path: filePath });
    expect(result).toContain('1→line1');
    expect(result).toContain('2→line2');
    expect(result).toContain('3→line3');
  });

  it('reads a file with offset and limit', async () => {
    const filePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\nline5', 'utf-8');

    const result = await tool.execute({ file_path: filePath, offset: 2, limit: 2 });
    expect(result).toContain('2→line2');
    expect(result).toContain('3→line3');
    expect(result).not.toContain('1→line1');
    expect(result).not.toContain('4→line4');
  });

  it('throws error for non-existent file', async () => {
    const filePath = path.join(tempDir, 'nonexistent.txt');
    await expect(tool.execute({ file_path: filePath })).rejects.toThrow(/File not found/);
  });

  it('throws error when path is a directory', async () => {
    await expect(tool.execute({ file_path: tempDir })).rejects.toThrow(/not a file/);
  });
});

// ─── WriteTool ─────────────────────────────────────────────────────────

describe('WriteTool', () => {
  const tool = new WriteTool();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('writes content to a file', async () => {
    const filePath = path.join(tempDir, 'output.txt');
    const result = await tool.execute({ file_path: filePath, content: 'Hello World' });

    expect(result).toContain('Successfully wrote');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('Hello World');
  });

  it('creates parent directories automatically', async () => {
    const filePath = path.join(tempDir, 'sub', 'dir', 'output.txt');
    await tool.execute({ file_path: filePath, content: 'nested' });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('nested');
  });

  it('overwrites existing file', async () => {
    const filePath = path.join(tempDir, 'output.txt');
    await fs.writeFile(filePath, 'old content', 'utf-8');
    // read-before-write 门控：覆盖已存在文件前必须先 read
    await new ReadTool().execute({ file_path: filePath });
    await tool.execute({ file_path: filePath, content: 'new content' });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('new content');
  });

  it('reports correct line count', async () => {
    const filePath = path.join(tempDir, 'output.txt');
    const result = await tool.execute({ file_path: filePath, content: 'line1\nline2\nline3' });
    expect(result).toContain('3 lines');
  });
});

// ─── EditTool ──────────────────────────────────────────────────────────

describe('EditTool', () => {
  const tool = new EditTool();
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
    filePath = path.join(tempDir, 'edit.txt');
    await fs.writeFile(filePath, 'Hello World\nSecond line\nThird line', 'utf-8');
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('edits a line in a file', async () => {
    // read-before-write 门控：编辑前必须先 read
    await new ReadTool().execute({ file_path: filePath });
    await tool.execute({ file_path: filePath, old_string: 'Hello World', new_string: 'Hello Agent' });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('Hello Agent');
    expect(content).not.toContain('Hello World');
  });

  it('throws error when old_string is not found', async () => {
    await new ReadTool().execute({ file_path: filePath });
    await expect(
      tool.execute({ file_path: filePath, old_string: 'Not found', new_string: 'replacement' }),
    ).rejects.toThrow(/String not found/);
  });

  it('throws error when multiple matches exist without replace_all', async () => {
    await fs.writeFile(filePath, 'aaa\naaa\nbbb', 'utf-8');
    await new ReadTool().execute({ file_path: filePath });
    await expect(
      tool.execute({ file_path: filePath, old_string: 'aaa', new_string: 'ccc' }),
    ).rejects.toThrow(/Multiple matches found/);
  });

  it('replaces all occurrences with replace_all=true', async () => {
    await fs.writeFile(filePath, 'aaa\naaa\nbbb', 'utf-8');
    await new ReadTool().execute({ file_path: filePath });
    await tool.execute({ file_path: filePath, old_string: 'aaa', new_string: 'ccc', replace_all: true });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('ccc\nccc\nbbb');
  });

  it('throws error for non-existent file', async () => {
    const nonExistent = path.join(tempDir, 'nope.txt');
    await expect(
      tool.execute({ file_path: nonExistent, old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/File not found/);
  });
});

// ─── GlobTool ──────────────────────────────────────────────────────────

describe('GlobTool', () => {
  const tool = new GlobTool();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
    // Create a file structure for testing
    await ensureDir(path.join(tempDir, 'src'));
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src', 'utils.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'README.md'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'package.json'), '', 'utf-8');
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('finds files matching a pattern', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', path: tempDir });
    expect(result).toContain('index.ts');
    expect(result).toContain('utils.ts');
  });

  it('returns "No files matched" for non-matching pattern', async () => {
    const result = await tool.execute({ pattern: '**/*.py', path: tempDir });
    expect(result).toBe('No files matched the pattern');
  });

  it('matches single-level pattern', async () => {
    const result = await tool.execute({ pattern: '*.md', path: tempDir });
    expect(result).toContain('README.md');
  });

  it('throws error for non-existent directory', async () => {
    await expect(
      tool.execute({ pattern: '*.ts', path: path.join(tempDir, 'nonexistent') }),
    ).rejects.toThrow(/Directory not found/);
  });
});

// ─── MultiEditTool ─────────────────────────────────────────────────────

describe('MultiEditTool', () => {
  const tool = new MultiEditTool();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
    // Create two files with a common placeholder
    await ensureDir(path.join(tempDir, 'src'));
    await fs.writeFile(path.join(tempDir, 'src', 'a.ts'), 'const VERSION = "v0";\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src', 'b.ts'), 'const VERSION = "v0";\n', 'utf-8');
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('replaces across multiple files matched by glob (regression: missing path arg)', async () => {
    // read-before-write gate: must mark both files as read first
    recordFileRead(path.join(tempDir, 'src', 'a.ts'));
    recordFileRead(path.join(tempDir, 'src', 'b.ts'));

    const result = await tool.execute({
      glob: 'src/*.ts',
      path: tempDir,
      old_string: '"v0"',
      new_string: '"v1"',
    });

    expect(result).toContain('Modified 2 file');
    const a = await fs.readFile(path.join(tempDir, 'src', 'a.ts'), 'utf-8');
    const b = await fs.readFile(path.join(tempDir, 'src', 'b.ts'), 'utf-8');
    expect(a).toContain('"v1"');
    expect(b).toContain('"v1"');
  });

  it('previews changes with dry_run without writing', async () => {
    // read-before-write gate runs before the dry_run branch — mark all matched files as read
    recordFileRead(path.join(tempDir, 'src', 'a.ts'));
    recordFileRead(path.join(tempDir, 'src', 'b.ts'));

    const result = await tool.execute({
      glob: 'src/*.ts',
      path: tempDir,
      old_string: '"v0"',
      new_string: '"v1"',
      dry_run: true,
    });

    expect(result).toContain('Preview');
    const a = await fs.readFile(path.join(tempDir, 'src', 'a.ts'), 'utf-8');
    expect(a).toContain('"v0"'); // unchanged
  });

  it('rejects editing a file that was never read (read-before-write gate)', async () => {
    const result = await tool.execute({
      glob: 'src/*.ts',
      path: tempDir,
      old_string: '"v0"',
      new_string: '"v1"',
    });

    expect(result).toContain('You must read');
    const a = await fs.readFile(path.join(tempDir, 'src', 'a.ts'), 'utf-8');
    expect(a).toContain('"v0"'); // unchanged
  });

  it('returns "No files matched" for an unmatched pattern', async () => {
    const result = await tool.execute({
      glob: 'src/*.py',
      path: tempDir,
      old_string: '"v0"',
      new_string: '"v1"',
    });
    expect(result).toContain('No files matched');
  });
});

// ─── BashTool ──────────────────────────────────────────────────────────

describe('BashTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await removeDir(tempDir);
  });

  it('executes a simple command', async () => {
    const tool = new BashTool(tempDir);
    const result = await tool.execute({ command: 'echo hello' });
    expect(result).toContain('hello');
  });

  it('blocked command returns error', async () => {
    const tool = new BashTool(tempDir);
    await expect(
      tool.execute({ command: 'rm -rf /' }),
    ).rejects.toThrow(/Command blocked by (security kernel|sandbox)/);
  });

  it('custom blocked commands are enforced', async () => {
    const tool = new BashTool(tempDir, {
      allowedPaths: [tempDir],
      blockedCommands: ['dangerous_cmd'],
    });
    await expect(
      tool.execute({ command: 'dangerous_cmd --force' }),
    ).rejects.toThrow(/Command blocked by sandbox/);
  });

  it('captures stderr in error output on Windows', async () => {
    const tool = new BashTool(tempDir);
    // On Windows PowerShell, Write-Error alone exits with code 0,
    // so force a non-zero exit code to make BashTool throw with stderr content.
    const isWin = os.platform() === 'win32';
    if (isWin) {
      // PowerShell: Write-Error writes to stderr; `exit 1` forces failure
      await expect(
        tool.execute({ command: 'Write-Error "test-error-output"; exit 1' }),
      ).rejects.toThrow(/test-error-output/);
    } else {
      // Unix: echo to stderr, command still succeeds
      const result = await tool.execute({ command: 'echo error >&2' });
      expect(result).toContain('error');
    }
  });
});

// ─── ToolRegistry ──────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register() and get() work', () => {
    const mockTool: Tool = {
      name: 'mock',
      description: 'A mock tool',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    };

    registry.register(mockTool);
    expect(registry.get('mock')).toBe(mockTool);
  });

  it('get() returns undefined for unregistered tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getAll() returns all registered tools', () => {
    const tool1: Tool = { name: 'tool1', description: 'Tool 1', inputSchema: {}, execute: async () => '' };
    const tool2: Tool = { name: 'tool2', description: 'Tool 2', inputSchema: {}, execute: async () => '' };

    registry.register(tool1);
    registry.register(tool2);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(t => t.name)).toContain('tool1');
    expect(all.map(t => t.name)).toContain('tool2');
  });

  it('getToolDefinitions() returns correct format', () => {
    const mockTool: Tool = {
      name: 'mock',
      description: 'A mock tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    };

    registry.register(mockTool);
    const defs = registry.getToolDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      name: 'mock',
      description: 'A mock tool',
      input_schema: { type: 'object', properties: {} },
    });
  });

  it('has() checks tool existence', () => {
    const mockTool: Tool = { name: 'mock', description: '', inputSchema: {}, execute: async () => '' };
    registry.register(mockTool);

    expect(registry.has('mock')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('register() overwrites existing tool with same name', () => {
    const tool1: Tool = { name: 'tool', description: 'v1', inputSchema: {}, execute: async () => 'v1' };
    const tool2: Tool = { name: 'tool', description: 'v2', inputSchema: {}, execute: async () => 'v2' };

    registry.register(tool1);
    registry.register(tool2);

    expect(registry.get('tool')?.description).toBe('v2');
    expect(registry.getAll()).toHaveLength(1);
  });
});

// ─── ToolExecutor ──────────────────────────────────────────────────────

describe('ToolExecutor', () => {
  function makeExecutor(overrides: { timeoutMs?: number; tools?: Tool[] } = {}) {
    const registry = new ToolRegistry();
    for (const t of overrides.tools ?? []) registry.register(t);
    return new ToolExecutor(registry, overrides.timeoutMs ?? 300_000);
  }

  it('executes a tool and returns its result', async () => {
    const tool: Tool = { name: 'echo', description: '', inputSchema: {}, execute: async (a) => `got:${a.value}` };
    const executor = makeExecutor({ tools: [tool] });

    const result = await executor.execute({ id: 'c1', name: 'echo', input: { value: 'hi' } } as never);
    expect(result.content).toBe('got:hi');
    expect(result.is_error).toBeFalsy();
  });

  it('returns error for unknown tool', async () => {
    const executor = makeExecutor();
    const result = await executor.execute({ id: 'c1', name: 'nope', input: {} } as never);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('aborts the tool signal on timeout (no orphaned work)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const slowTool: Tool = {
      name: 'slow',
      description: '',
      inputSchema: {},
      execute: (_args, signal) => {
        receivedSignal = signal;
        return new Promise<string>((resolve) => {
          // Simulates a tool that ignores abort but would otherwise run forever
          const interval = setInterval(() => resolve('done-late'), 5000);
          signal?.addEventListener('abort', () => {
            clearInterval(interval);
            // eslint-disable-next-line no-restricted-syntax
            resolve('aborted-cleanly');
          }, { once: true });
        });
      },
    };
    const executor = makeExecutor({ timeoutMs: 50, tools: [slowTool] });

    const result = await executor.execute({ id: 'c1', name: 'slow', input: {} } as never);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('propagates tool error as is_error', async () => {
    const failingTool: Tool = {
      name: 'fail',
      description: '',
      inputSchema: {},
      execute: async () => { throw new Error('boom'); },
    };
    const executor = makeExecutor({ tools: [failingTool] });

    const result = await executor.execute({ id: 'c1', name: 'fail', input: {} } as never);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('boom');
  });
});
