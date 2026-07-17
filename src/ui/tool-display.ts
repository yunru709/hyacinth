type ToolDisplay = {
  name: string;
  emoji: string;
  label: string;
  detail?: string;
};

type ToolSpec = {
  emoji: string;
  label: string;
  detailKeys?: string[];
};

const TOOL_DISPLAY: Record<string, ToolSpec> = {
  read:             { emoji: '\u{1F4D6}', label: 'Read',             detailKeys: ['path', 'file_path'] },
  write:            { emoji: '\u270D\uFE0F', label: 'Write',        detailKeys: ['path', 'file_path'] },
  edit:             { emoji: '\u{1F4DD}', label: 'Edit',             detailKeys: ['path', 'file_path'] },
  multi_edit:       { emoji: '\u{1F4DD}\u2702\uFE0F', label: 'Multi-Edit', detailKeys: ['pattern'] },
  bash:             { emoji: '\u{1F6E0}\uFE0F', label: 'Bash',      detailKeys: ['command'] },
  glob:             { emoji: '\u{1F50D}', label: 'Glob',             detailKeys: ['pattern'] },
  grep:             { emoji: '\u{1F50E}', label: 'Grep',             detailKeys: ['pattern'] },
  git:              { emoji: '\u{1F418}', label: 'Git',              detailKeys: ['action'] },

  web_search:       { emoji: '\u{1F310}', label: 'Web Search',       detailKeys: ['query'] },
  web_fetch:        { emoji: '\u{1F4C4}', label: 'Web Fetch',        detailKeys: ['url'] },

  use_skill:        { emoji: '\u{1F9E0}', label: 'Use Skill',        detailKeys: ['name'] },
  delegate_to_agent:{ emoji: '\u{1F916}', label: 'Delegate',         detailKeys: ['task', 'agent_id'] },

  get_config:       { emoji: '\u2699\uFE0F', label: 'Get Config',    detailKeys: ['key'] },
  update_config:    { emoji: '\u2699\uFE0F', label: 'Update Config', detailKeys: ['key'] },
  config_schema:    { emoji: '\u{1F4CB}', label: 'Config Schema',    detailKeys: [] },
  reset_config:     { emoji: '\u{1F504}', label: 'Reset Config',     detailKeys: [] },

  switch_provider:     { emoji: '\u{1F50C}', label: 'Switch Provider',     detailKeys: ['provider'] },
  list_providers:      { emoji: '\u{1F4CB}', label: 'List Providers',      detailKeys: [] },
  provider_info:       { emoji: '\u2139\uFE0F', label: 'Provider Info',    detailKeys: [] },
  switch_to_auto_route:{ emoji: '\u{1F500}', label: 'Auto Route',          detailKeys: [] },

  toggle_tool:     { emoji: '\u{1F527}', label: 'Toggle Tool',     detailKeys: ['tool'] },
  list_tools:      { emoji: '\u{1F4CB}', label: 'List Tools',      detailKeys: [] },
  toggle_skill:    { emoji: '\u{1F527}', label: 'Toggle Skill',    detailKeys: ['skill'] },
  list_skills:     { emoji: '\u{1F4CB}', label: 'List Skills',     detailKeys: [] },

  toggle_sub_agent: { emoji: '\u{1F527}', label: 'Toggle Sub Agent', detailKeys: ['agent_id'] },
  list_sub_agents:  { emoji: '\u{1F4CB}', label: 'List Sub Agents',  detailKeys: [] },
  spawn_sub_agent:  { emoji: '\u{1F916}', label: 'Spawn Sub Agent',  detailKeys: ['task'] },
  create_sub_agent: { emoji: '\u{1F916}', label: 'Create Sub Agent', detailKeys: ['name'] },

  interrupt:        { emoji: '\u23F8\uFE0F', label: 'Interrupt',     detailKeys: [] },
  session_stats:    { emoji: '\u{1F4CA}', label: 'Session Stats',    detailKeys: [] },

  allow_tool:      { emoji: '\u2705', label: 'Allow Tool',      detailKeys: ['tool'] },
  disallow_tool:   { emoji: '\u274C', label: 'Disallow Tool',   detailKeys: ['tool'] },
  list_allowlist:  { emoji: '\u{1F4CB}', label: 'Allowlist',    detailKeys: [] },

  add_task:        { emoji: '\u2795', label: 'Add Task',        detailKeys: ['name'] },
  remove_task:     { emoji: '\u2796', label: 'Remove Task',     detailKeys: ['name'] },
  list_tasks:      { emoji: '\u{1F4CB}', label: 'List Tasks',   detailKeys: [] },
  toggle_task:     { emoji: '\u{1F527}', label: 'Toggle Task',  detailKeys: ['name'] },

  companion_mode:             { emoji: '\u{1F48C}', label: 'Companion Mode', detailKeys: ['action'] },
  reset_companion_session:    { emoji: '\u{1F4AD}', label: 'Reset Memory',   detailKeys: [] },
};

const FALLBACK_EMOJI = '\u{1F9E9}';

function normalizeToolName(name?: string): string {
  return (name ?? 'tool').trim();
}

function resolveDetail(args: unknown, spec?: ToolSpec): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;

  const keys = spec?.detailKeys;
  if (!keys || keys.length === 0) return undefined;

  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > 80) return trimmed.slice(0, 77) + '...';
    return trimmed;
  }
  return undefined;
}

export function resolveToolDisplay(params: { name?: string; args?: unknown }): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec = TOOL_DISPLAY[key];
  return {
    name,
    emoji: spec?.emoji ?? FALLBACK_EMOJI,
    label: spec?.label ?? name,
    detail: resolveDetail(params.args, spec),
  };
}

export function formatToolSummary(display: ToolDisplay): string {
  if (display.detail && display.name === 'bash') {
    return `${display.emoji} ${display.detail}`;
  }
  return display.detail
    ? `${display.emoji} ${display.label}: ${display.detail}`
    : `${display.emoji} ${display.label}`;
}
