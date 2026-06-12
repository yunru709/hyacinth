import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

export interface ConversationEvent {
  type: 'user_input' | 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'stop' | 'usage';
  content?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  message?: string;
  reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  timestamp: string;
}

/**
 * Append a single event to the session's events.jsonl file.
 */
export async function appendEvent(
  sessionDir: string,
  event: ConversationEvent,
): Promise<void> {
  const filePath = path.join(sessionDir, 'events.jsonl');
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

/**
 * Read the most recent N events from the session's events.jsonl.
 * Returns events sorted from oldest to newest.
 */
export async function readRecentEvents(
  sessionDir: string,
  limit: number = 50,
): Promise<ConversationEvent[]> {
  const filePath = path.join(sessionDir, 'events.jsonl');
  
  try {
    await fs.access(filePath);
  } catch {
    return []; // No events file yet
  }

  // Read all lines, take the last N
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      lines.push(line.trim());
    }
  }

  // Take last N lines
  const recent = lines.slice(-limit);
  
  return recent
    .map(line => {
      try {
        return JSON.parse(line) as ConversationEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ConversationEvent => e !== null);
}

/**
 * Get the total number of events in the session.
 */
export async function getEventCount(sessionDir: string): Promise<number> {
  const filePath = path.join(sessionDir, 'events.jsonl');
  try {
    await fs.access(filePath);
  } catch {
    return 0;
  }

  let count = 0;
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) count++;
  }

  return count;
}