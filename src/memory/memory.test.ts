import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SessionManager } from './session.js';
import { ConversationStore } from './conversation.js';
import { StatsManager } from './stats.js';
import { SummaryStore } from './summary.js';
import { EventStore } from './events.js';

// ─── Test helpers ──────────────────────────────────────────────────────

/** Create a temporary directory for test isolation */
function makeTempDir(): string {
  return path.join(os.tmpdir(), `agent-test-${crypto.randomUUID()}`);
}

/** Ensure a directory exists */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Remove a directory recursively */
async function removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

// ─── ConversationStore ─────────────────────────────────────────────────

describe('ConversationStore', () => {
  const store = new ConversationStore(100);
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = makeTempDir();
    await ensureDir(sessionDir);
  });

  afterEach(async () => {
    await removeDir(sessionDir);
  });

  it('append() and readAll() round-trip', async () => {
    const msg1 = { role: 'user' as const, content: { type: 'text' as const, text: 'Hello' } };
    const msg2 = { role: 'assistant' as const, content: { type: 'text' as const, text: 'World' } };

    await store.append(sessionDir, msg1);
    await store.append(sessionDir, msg2);

    const all = await store.readAll(sessionDir);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(msg1);
    expect(all[1]).toEqual(msg2);
  });

  it('readLast() returns correct count', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: { type: 'text' as const, text: `Message ${i}` },
    }));

    for (const msg of messages) {
      await store.append(sessionDir, msg);
    }

    const last3 = await store.readLast(sessionDir, 3);
    expect(last3).toHaveLength(3);
    expect(last3[0].content).toEqual({ type: 'text', text: 'Message 2' });
    expect(last3[2].content).toEqual({ type: 'text', text: 'Message 4' });
  });

  it('count() is accurate', async () => {
    expect(await store.count(sessionDir)).toBe(0);

    await store.append(sessionDir, { role: 'user', content: { type: 'text', text: 'A' } });
    expect(await store.count(sessionDir)).toBe(1);

    await store.append(sessionDir, { role: 'assistant', content: { type: 'text', text: 'B' } });
    expect(await store.count(sessionDir)).toBe(2);
  });

  it('readAll() returns empty array for non-existent directory', async () => {
    const nonExistent = path.join(os.tmpdir(), `nonexistent-${crypto.randomUUID()}`);
    const result = await store.readAll(nonExistent);
    expect(result).toEqual([]);
  });

  it('should truncate old messages when exceeding maxMessages', async () => {
    const smallStore = new ConversationStore(3);
    const dir = makeTempDir();
    await ensureDir(dir);

    try {
      await smallStore.append(dir, { role: 'user', content: { type: 'text', text: '1' } });
      await smallStore.append(dir, { role: 'user', content: { type: 'text', text: '2' } });
      await smallStore.append(dir, { role: 'user', content: { type: 'text', text: '3' } });
      await smallStore.append(dir, { role: 'user', content: { type: 'text', text: '4' } });

      const messages = await smallStore.readAll(dir);
      expect(messages).toHaveLength(3);
      expect((messages[0].content as { type: 'text'; text: string }).text).toBe('2'); // 最旧的 (1) 被移除
      expect((messages[2].content as { type: 'text'; text: string }).text).toBe('4'); // 最新的保留
    } finally {
      await removeDir(dir);
    }
  });
});

// ─── StatsManager ──────────────────────────────────────────────────────

describe('StatsManager', () => {
  const manager = new StatsManager();
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = makeTempDir();
    await ensureDir(sessionDir);
  });

  afterEach(async () => {
    await removeDir(sessionDir);
  });

  it('init() creates stats.json with default values', async () => {
    await manager.init(sessionDir);

    const stats = await manager.get(sessionDir);
    expect(stats).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      turn_count: 0,
      compact_count: 0,
      current_context_tokens: 0,
    });
  });

  it('update() modifies specified fields', async () => {
    await manager.init(sessionDir);
    await manager.update(sessionDir, { input_tokens: 100, turn_count: 5 });

    const stats = await manager.get(sessionDir);
    expect(stats.input_tokens).toBe(100);
    expect(stats.turn_count).toBe(5);
    expect(stats.output_tokens).toBe(0); // unchanged
  });

  it('increment() increments counters', async () => {
    await manager.init(sessionDir);
    await manager.increment(sessionDir, 'turn_count', 1);
    await manager.increment(sessionDir, 'turn_count', 1);
    await manager.increment(sessionDir, 'input_tokens', 50);

    const stats = await manager.get(sessionDir);
    expect(stats.turn_count).toBe(2);
    expect(stats.input_tokens).toBe(50);
  });

  it('get() returns defaults when file does not exist', async () => {
    const stats = await manager.get(sessionDir);
    expect(stats).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      turn_count: 0,
      compact_count: 0,
      current_context_tokens: 0,
    });
  });
});

// ─── SummaryStore ──────────────────────────────────────────────────────

describe('SummaryStore', () => {
  const store = new SummaryStore();
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = makeTempDir();
    await ensureDir(sessionDir);
  });

  afterEach(async () => {
    await removeDir(sessionDir);
  });

  it('save() writes summary.md and load() reads it back', async () => {
    const summary = '# Session Summary\n\nThis is a test summary.';
    await store.save(sessionDir, summary);

    const loaded = await store.load(sessionDir);
    expect(loaded).toBe(summary);
  });

  it('load() returns null for missing file', async () => {
    const loaded = await store.load(sessionDir);
    expect(loaded).toBeNull();
  });

  it('load() returns null for empty file', async () => {
    await fs.writeFile(path.join(sessionDir, 'summary.md'), '', 'utf-8');
    const loaded = await store.load(sessionDir);
    expect(loaded).toBeNull();
  });
});

// ─── EventStore ────────────────────────────────────────────────────────

describe('EventStore', () => {
  const store = new EventStore();
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = makeTempDir();
    await ensureDir(sessionDir);
  });

  afterEach(async () => {
    await removeDir(sessionDir);
  });

  it('append() and readAll() round-trip', async () => {
    const event1 = { type: 'session_start', session_id: 'test-1', timestamp: new Date().toISOString() };
    const event2 = { type: 'usage', input_tokens: 10, output_tokens: 20, timestamp: new Date().toISOString() };

    await store.append(sessionDir, event1);
    await store.append(sessionDir, event2);

    const all = await store.readAll(sessionDir);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(event1);
    expect(all[1]).toEqual(event2);
  });

  it('readLast() returns correct count', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(sessionDir, { type: 'usage', input_tokens: i, output_tokens: 0, timestamp: new Date().toISOString() });
    }

    const last2 = await store.readLast(sessionDir, 2);
    expect(last2).toHaveLength(2);
  });
});

// ─── SessionManager ────────────────────────────────────────────────────

describe('SessionManager', () => {
  let tempProjectDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    // Use a unique temp directory as the "cwd" so sessions are isolated
    tempProjectDir = makeTempDir();
    await ensureDir(tempProjectDir);
    manager = new SessionManager(tempProjectDir);
  });

  afterEach(async () => {
    // Clean up the project directory under ~/.agent/sessions/
    const projectKey = manager.getProjectKey();
    const projectDir = path.join(os.homedir(), '.agent', 'sessions', projectKey);
    await removeDir(projectDir);
    await removeDir(tempProjectDir);
  });

  it('create() creates session directory with required files', async () => {
    const session = await manager.create();

    expect(session.id).toBeTruthy();
    expect(session.projectKey).toBe(manager.getProjectKey());
    expect(session.createdAt).toBeTruthy();

    const sessionDir = manager.getSessionDir(session.id);

    // Verify required files exist
    const files = ['conversation.jsonl', 'events.jsonl', 'stats.json'];
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }
  });

  it('resume() loads existing session by id', async () => {
    const created = await manager.create();
    const resumed = await manager.resume(created.id);

    expect(resumed.id).toBe(created.id);
    expect(resumed.projectKey).toBe(created.projectKey);
  });

  it('resume() without id returns latest session', async () => {
    const session1 = await manager.create();
    const session2 = await manager.create();

    const latest = await manager.resume();
    // The latest should be one of the created sessions
    expect([session1.id, session2.id]).toContain(latest.id);
  });

  it('resume() throws when no sessions exist', async () => {
    await expect(manager.resume()).rejects.toThrow(/No sessions found/);
  });

  it('cleanup() deletes old sessions', async () => {
    const session = await manager.create();

    // Cleanup with maxAgeDays=0 should delete all sessions
    const deletedCount = await manager.cleanup(0);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // Verify session directory is gone
    const sessionDir = manager.getSessionDir(session.id);
    const exists = await fs.access(sessionDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('list() returns sessions sorted by createdAt descending', async () => {
    await manager.create();
    await manager.create();

    const sessions = await manager.list();
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Verify descending order
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].createdAt >= sessions[i].createdAt).toBe(true);
    }
  });
});
