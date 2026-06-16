/**
 * Tool Arguments Recovery — best-effort extraction of tool parameters
 * from malformed JSON strings.
 *
 * When a model generates a tool call with large content (e.g., Write tool
 * with source code), the streaming JSON may be truncated or contain
 * unescaped characters. Rather than falling back to empty `{}`, we attempt
 * to salvage known fields via regex extraction.
 */

/**
 * Result of best-effort JSON recovery.
 * - recovered: Record of successfully extracted fields
 * - complete: true if the original JSON was valid (no recovery needed)
 * - error: parse error message if JSON was invalid
 */
export interface RecoveryResult {
  recovered: Record<string, unknown>;
  complete: boolean;
  error?: string;
}

/**
 * Try to parse JSON, with fallback regex-based recovery for known tool patterns.
 *
 * Known patterns (in priority order):
 * - "file_path": extracted via regex for write/edit/read tools
 * - "content": extracted as everything after "content":" up to the end
 * - "path": generic path extraction
 * - "pattern": for glob/grep tools
 * - "command": for bash tool
 */
export function recoverToolArguments(
  raw: string,
  toolName: string,
): RecoveryResult {
  // First: try normal JSON parse
  try {
    const parsed = JSON.parse(raw || '{}');
    return { recovered: parsed, complete: true };
  } catch (e) {
    const error = (e as Error).message;
    const recovered: Record<string, unknown> = {};

    // ── file_path (write / edit / read) ──────────────────────
    const filePathMatch = raw.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (filePathMatch) {
      recovered.file_path = JSON.parse(`"${filePathMatch[1]}"`);
    }

    // ── content (write / edit) — grab everything after "content":" ──
    if (toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit' || toolName === 'insert') {
      const contentMatch = raw.match(/"content"\s*:\s*"/);
      if (contentMatch) {
        const contentStart = contentMatch.index! + contentMatch[0].length;
        let contentRaw = raw.slice(contentStart);
        // Strip trailing "} or "}\n or just " at the very end
        contentRaw = contentRaw.replace(/"?\s*\}?\s*$/, '');
        // Unescape JSON escapes
        try {
          recovered.content = JSON.parse(`"${contentRaw}"`);
        } catch {
          // If unescaping fails, use raw content
          recovered.content = contentRaw;
        }
      }
    }

    // ── path (generic) ───────────────────────────────────────
    if (!recovered.file_path && !recovered.path) {
      const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (pathMatch) {
        recovered.path = JSON.parse(`"${pathMatch[1]}"`);
      }
    }

    // ── pattern (glob / grep) ────────────────────────────────
    if (toolName === 'glob' || toolName === 'grep') {
      const patternMatch = raw.match(/"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (patternMatch) {
        recovered.pattern = JSON.parse(`"${patternMatch[1]}"`);
      }
    }

    // ── command (bash) ───────────────────────────────────────
    if (toolName === 'bash') {
      const cmdMatch = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cmdMatch) {
        recovered.command = JSON.parse(`"${cmdMatch[1]}"`);
      }
    }

    return { recovered, complete: false, error };
  }
}

/**
 * Log a warning about tool call arguments that are empty or failed to parse.
 */
export function logToolArgsWarning(
  providerLabel: string,
  toolName: string,
  raw: string,
  error?: string,
): void {
  const rawLen = raw?.length ?? 0;
  const preview = (raw || '').slice(0, 500);
  const suffix = rawLen > 500 ? `... (${rawLen - 500} more chars)` : '';

  if (error) {
    console.warn(
      `[${providerLabel}] JSON parse failed for tool "${toolName}": ${error}`,
    );
  } else if (!raw || rawLen === 0) {
    console.warn(
      `[${providerLabel}] Tool "${toolName}" called with EMPTY arguments (raw length: 0). The model may be hitting output limits or the stream chunk order is wrong.`,
    );
  }
  console.warn(`[${providerLabel}] raw (first 500 chars): ${preview}${suffix}`);
}
