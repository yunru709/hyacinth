const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const MAX_TOKEN_CHARS = 32;
const LONG_TOKEN_RE = /\S{33,}/g;
const LONG_TOKEN_TEST_RE = /\S{33,}/;
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const EDGE_PUNCTUATION_RE = /^[`"'([{<]+|[`"')\]}>.,:;!?]+$/g;
const ALPHANUMERIC_RE = /[A-Za-z0-9]/;
const TOKENISH_MIN_LENGTH = 24;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = '\u2067';
const RTL_ISOLATE_END = '\u2069';
const FENCED_CODE_RE = /(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*/g;
const INLINE_CODE_RE = /(`+)(?:(?!\1).)+?\1/g;

const ANSI_CSI_PATTERN = '\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]';
const ANSI_OSC_PATTERN = '\\x1b\\][^\\x07\\x1b]*(?:\\x1b\\\\|\\x07)';
const ANSI_CSI_REGEX = new RegExp(ANSI_CSI_PATTERN, 'g');
const ANSI_OSC_REGEX = new RegExp(ANSI_OSC_PATTERN, 'g');

function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC_REGEX, '').replace(ANSI_CSI_REGEX, '');
}

function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (isAsciiControl || isC1Control) return true;
  }
  return false;
}

function stripControlChars(text: string): string {
  if (!hasControlChars(text)) return text;
  let sanitized = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (!isAsciiControl && !isC1Control) sanitized += char;
  }
  return sanitized;
}

function chunkToken(token: string, maxChars: number): string[] {
  if (token.length <= maxChars) return [token];
  const chunks: string[] = [];
  for (let i = 0; i < token.length; i += maxChars) {
    chunks.push(token.slice(i, i + maxChars));
  }
  return chunks;
}

function isCopySensitiveToken(token: string): boolean {
  const coreToken = token.replace(EDGE_PUNCTUATION_RE, '');
  const candidate = coreToken || token;
  if (URL_PREFIX_RE.test(candidate)) return true;
  if (candidate.startsWith('/') || candidate.startsWith('~/') || candidate.startsWith('./') || candidate.startsWith('../')) return true;
  if (WINDOWS_DRIVE_RE.test(candidate) || candidate.startsWith('\\\\')) return true;
  if (candidate.includes('/') || candidate.includes('\\')) return true;
  if (FILE_LIKE_RE.test(candidate) && (candidate.includes('_') || candidate.includes('-') || candidate.includes('.'))) return true;
  if (candidate.length >= TOKENISH_MIN_LENGTH && /[a-z]/i.test(candidate) && /\d/.test(candidate)) return true;
  return false;
}

function normalizeLongTokenForDisplay(token: string): string {
  if (isCopySensitiveToken(token)) return token;
  if (!ALPHANUMERIC_RE.test(token)) return token;
  return chunkToken(token, MAX_TOKEN_CHARS).join(' ');
}

type Segment = { kind: 'prose' | 'code'; text: string };

function partitionByRegex(text: string, re: RegExp): Segment[] {
  const parts: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push({ kind: 'prose', text: text.slice(lastIndex, start) });
    parts.push({ kind: 'code', text: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ kind: 'prose', text: text.slice(lastIndex) });
  return parts;
}

function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const fenced = partitionByRegex(text, FENCED_CODE_RE);
  return fenced
    .map((seg) => {
      if (seg.kind === 'code') return seg.text;
      const inline = partitionByRegex(seg.text, INLINE_CODE_RE);
      return inline.map((s) => (s.kind === 'code' ? s.text : transform(s.text))).join('');
    })
    .join('');
}

function redactBinaryLikeLine(line: string): string {
  const replacementCount = (line.match(REPLACEMENT_CHAR_RE) || []).length;
  if (replacementCount >= BINARY_LINE_REPLACEMENT_THRESHOLD && replacementCount * 2 >= line.length) {
    return '[binary data omitted]';
  }
  return line;
}

function isolateRtlLine(line: string): string {
  if (!RTL_SCRIPT_RE.test(line) || BIDI_CONTROL_RE.test(line)) return line;
  return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}

function applyRtlIsolation(text: string): string {
  if (!RTL_SCRIPT_RE.test(text)) return text;
  return text.split('\n').map((line) => isolateRtlLine(line)).join('\n');
}

export function sanitizeRenderableText(text: string): string {
  if (!text) return text;

  const hasAnsi = text.includes('\u001b');
  const hasReplacementChars = text.includes('\uFFFD');
  const hasLongTokens = LONG_TOKEN_TEST_RE.test(text);
  const hasControls = hasControlChars(text);
  if (!hasAnsi && !hasReplacementChars && !hasLongTokens && !hasControls) {
    return applyRtlIsolation(text);
  }

  const withoutAnsi = hasAnsi ? stripAnsi(text) : text;
  const withoutControlChars = hasControls ? stripControlChars(withoutAnsi) : withoutAnsi;
  const redacted = hasReplacementChars
    ? withoutControlChars.split('\n').map((line) => redactBinaryLikeLine(line)).join('\n')
    : withoutControlChars;
  const tokenSafe = LONG_TOKEN_TEST_RE.test(redacted)
    ? transformOutsideCode(redacted, (segment) =>
        LONG_TOKEN_TEST_RE.test(segment)
          ? segment.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay)
          : segment,
      )
    : redacted;
  return applyRtlIsolation(tokenSafe);
}
