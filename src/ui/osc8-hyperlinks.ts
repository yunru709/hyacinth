const SGR_PATTERN = '\\x1b\\[[0-9;]*m';
const OSC8_PATTERN = '\\x1b\\]8;;.*?(?:\\x07|\\x1b\\\\)';
const ANSI_RE = new RegExp(`${SGR_PATTERN}|${OSC8_PATTERN}`, 'g');
const SGR_START_RE = new RegExp(`^${SGR_PATTERN}`);
const OSC8_START_RE = new RegExp(`^${OSC8_PATTERN}`);

export function wrapOsc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export function extractUrls(markdown: string): string[] {
  const urls = new Set<string>();
  const mdLinkRe = /\[(?:[^\]]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(markdown)) !== null) {
    urls.add(m[1]);
  }
  const stripped = markdown.replace(
    /\[(?:[^\]]*)\]\(\s*<?https?:\/\/[^)\s>]+>?(?:\s+["'][^"']*["'])?\s*\)/g,
    '',
  );
  const bareRe = /https?:\/\/[^\s)\]>]+/g;
  while ((m = bareRe.exec(stripped)) !== null) {
    urls.add(m[0]);
  }
  return [...urls];
}

function stripAnsiForHyperlink(input: string): string {
  return input.replace(ANSI_RE, '');
}

interface UrlRange {
  start: number;
  end: number;
  url: string;
}

function findUrlRanges(
  visibleText: string,
  knownUrls: string[],
  pending: { url: string; consumed: number } | null,
): { ranges: UrlRange[]; pending: { url: string; consumed: number } | null } {
  const ranges: UrlRange[] = [];
  let newPending: { url: string; consumed: number } | null = null;
  let searchFrom = 0;

  if (pending) {
    const remaining = pending.url.slice(pending.consumed);
    const trimmed = visibleText.trimStart();
    const leadingSpaces = visibleText.length - trimmed.length;
    let matchLen = 0;
    for (let j = 0; j < remaining.length && j < trimmed.length; j++) {
      if (remaining[j] === trimmed[j]) matchLen++;
      else break;
    }
    if (matchLen > 0) {
      ranges.push({ start: leadingSpaces, end: leadingSpaces + matchLen, url: pending.url });
      searchFrom = leadingSpaces + matchLen;
      if (pending.consumed + matchLen < pending.url.length) {
        newPending = { url: pending.url, consumed: pending.consumed + matchLen };
      }
    }
  }

  const urlRe = /https?:\/\/[^\s)\]>]+/g;
  urlRe.lastIndex = searchFrom;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(visibleText)) !== null) {
    const fragment = match[0];
    const start = match.index;
    let resolvedUrl = fragment;
    let found = false;
    for (const known of knownUrls) {
      if (known === fragment) { resolvedUrl = known; found = true; break; }
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (known.startsWith(fragment) && known.length > bestLen) {
          resolvedUrl = known; bestLen = known.length; found = true;
        }
      }
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (fragment.startsWith(known) && known.length > bestLen) bestLen = known.length;
      }
    }
    ranges.push({ start, end: start + fragment.length, url: resolvedUrl });
    if (resolvedUrl.length > fragment.length && resolvedUrl.startsWith(fragment)) {
      newPending = { url: resolvedUrl, consumed: fragment.length };
    }
  }
  return { ranges, pending: newPending };
}

function applyOsc8Ranges(line: string, ranges: UrlRange[]): string {
  if (ranges.length === 0) return line;
  const urlAt = new Map<number, string>();
  for (const r of ranges) {
    for (let p = r.start; p < r.end; p++) urlAt.set(p, r.url);
  }
  let result = '';
  let visiblePos = 0;
  let activeUrl: string | null = null;
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      const sgr = line.slice(i).match(SGR_START_RE);
      if (sgr) { result += sgr[0]; i += sgr[0].length; continue; }
      const osc = line.slice(i).match(OSC8_START_RE);
      if (osc) { result += osc[0]; i += osc[0].length; continue; }
    }
    const targetUrl = urlAt.get(visiblePos) ?? null;
    if (targetUrl !== activeUrl) {
      if (activeUrl !== null) result += '\x1b]8;;\x07';
      if (targetUrl !== null) result += `\x1b]8;;${targetUrl}\x07`;
      activeUrl = targetUrl;
    }
    result += line[i];
    visiblePos++;
    i++;
  }
  if (activeUrl !== null) result += '\x1b]8;;\x07';
  return result;
}

export function addOsc8Hyperlinks(lines: string[], urls: string[]): string[] {
  if (urls.length === 0) return lines;
  let pending: { url: string; consumed: number } | null = null;
  return lines.map((line) => {
    const visible = stripAnsiForHyperlink(line);
    const result = findUrlRanges(visible, urls, pending);
    pending = result.pending;
    return applyOsc8Ranges(line, result.ranges);
  });
}
