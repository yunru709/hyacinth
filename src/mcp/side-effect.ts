/** Sanitize MCP name: replace non-alphanumeric chars (except - and _) with - */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
}

/** MCP 工具名中暗示副作用的操作关键词（如 create、delete、write 等） */
const SIDE_EFFECT_KEYWORDS = new Set([
  'navigate', 'create', 'delete', 'open', 'write', 'execute',
  'run', 'start', 'launch', 'install', 'remove', 'update',
  'send', 'post', 'put', 'patch',
]);

/** 判断 MCP 工具名是否暗示副作用（用于工具描述中标记 [side-effect]） */
export function hasSideEffect(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  for (const keyword of SIDE_EFFECT_KEYWORDS) {
    if (lower === keyword || lower.startsWith(keyword) || lower.includes(keyword)) {
      return true;
    }
  }
  return false;
}
