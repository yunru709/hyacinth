/**
 * 命令策略（P2-1，CodeWhale execpolicy 思路的 TS 版）—— 词法级危险命令判定。
 *
 * 问题：旧实现用正则匹配整条命令串，`rm -r -- /`、`rm -rf //`、`del /f/s/q C:\`、
 * `sudo rm -rf /` 等形态可绕过 `\brm\s+(?:-{1,2}[\w-]+\s+)+\/` 这类模式。
 *
 * 方案（对应 CodeWhale 的 flag-aware token 匹配 + 分段）：
 * 1. 按 && / || / & / ; / | 把命令切成若干「基础命令」段（忽略引号内的分隔符）；
 * 2. 每段做引号感知的 tokenize；
 * 3. baseCommand：取首个可执行 token（跳过 sudo / env / VAR= 赋值 / 选项，剥离 .exe）；
 * 4. positionalArgs：flag-aware 提取位置参数（丢弃选项及选项值、`--` 终止符）；
 * 5. expandSegments：穿透 shell 包装（bash -c / powershell -Command / cmd /c…）递归检查嵌套命令，
 *    避免 `bash -c 'rm -rf /'` 漏网（旧正则靠整串搜索反而能拦，这里必须显式展开）；
 * 6. 硬拒绝规则 = 结构化谓词（base + 位置参数 + 原样段），而非正则。
 *
 * 纯函数、零依赖，独立可测、跨项目可移植。
 */

// ── 解析 ────────────────────────────────────────────────────────────

/** 把命令按 && / || / & / ; / | 切段（引号感知），每段再 tokenize（引号感知） */
export function parseCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current = '';
  let segTokens: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flushToken = () => {
    if (current.length > 0) {
      segTokens.push(current);
      current = '';
    }
  };
  const flushSegment = () => {
    flushToken();
    if (segTokens.length > 0) {
      segments.push(segTokens);
      segTokens = [];
    }
  };

  const SHELL_SPECIAL = new Set(['\\', ' ', '\t', '&', '|', ';']);
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") {
      const next = command[i + 1];
      // 转义仅限：shell 特殊字符（空格/分隔符/反斜杠），或未引号状态下紧跟引号（bash \"）。
      // 引号状态下的 \"（PowerShell 路径 C:\"）按字面保留 —— PowerShell 反斜杠不是转义。
      const isEscape = next !== undefined && (SHELL_SPECIAL.has(next) || (quote === null && (next === '"' || next === "'")));
      if (isEscape) { escaped = true; continue; }
      current += ch; // 普通反斜杠（Windows 路径）按字面保留
      continue;
    }
    if (quote) {
      if (ch === quote) { quote = null; }
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    // 分隔符（& | ;）：切段；连续分隔符（&&/||）的第二个字符只是再次空切，天然无害
    if (ch === '&' || ch === '|' || ch === ';') { flushSegment(); continue; }
    if (/\s/.test(ch)) { flushToken(); continue; }
    current += ch;
  }
  flushSegment();
  return segments;
}

/** 引号感知的整条命令 tokenize（不切段；供规则在必要时看原样段） */
export function tokenize(command: string): string[] {
  return parseCommandSegments(command)[0] ?? [];
}

/**
 * 提取基础命令名：跳过 sudo / env / VAR= 赋值 / 以 - 开头的选项，剥离 .exe 后缀，小写化。
 * 返回 undefined 表示无有效命令。
 */
export function baseCommand(tokens: string[]): string | undefined {
  for (const raw of tokens) {
    if (raw === 'sudo' || raw === 'env' || raw === 'command') continue;
    if (raw.startsWith('-')) continue;
    if (raw.includes('=')) continue; // VAR=val 赋值
    const name = raw.replace(/\.exe$/i, '').toLowerCase();
    if (name.length === 0) continue;
    return name;
  }
  return undefined;
}

// 短选项 + 明确带值的长选项（flag-aware：选项值不作为位置参数）
const OPTION_WITH_VALUE = new Set([
  '-c', '-C', '-o', '-e', '-p', '-u', '-P', '-t', '-w', '-f',
  '--config', '--exec-path', '--git-dir', '--work-tree',
  '--output', '--input', '--file', '--directory', '--path',
]);

/**
 * flag-aware 位置参数提取：丢弃选项（-x / --xxx）、带值选项的选项值、
 * Windows 单字母旗标（/f /s /q）、`--` 终止符（其后全部视为位置参数）。
 */
export function positionalArgs(tokens: string[]): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (afterDoubleDash) { out.push(t); continue; }
    if (t === '--') { afterDoubleDash = true; continue; }
    if (t.startsWith('--')) {
      if (!t.includes('=') && OPTION_WITH_VALUE.has(t)) i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && t !== '-') {
      if (OPTION_WITH_VALUE.has(t)) i++;
      continue;
    }
    if (t.startsWith('/') && /^\/[a-zA-Z]$/.test(t)) continue; // Windows 旗标
    out.push(t);
  }
  return out;
}

/** 判定是否为"根目录/盘根"路径：/、//、C:\、C:/（含大小写） */
export function isRootPath(arg: string): boolean {
  const t = arg.trim();
  if (t === '/' || t === '//') return true;
  return /^[A-Za-z]:[\\/]$/.test(t) || /^[A-Za-z]:[\\/]+$/.test(t);
}

// ── shell 包装穿透 ─────────────────────────────────────────────────

/** base → 取脚本/命令的包装旗标（如 bash -c、powershell -Command、cmd /c） */
const SHELL_WRAPPERS: Record<string, string[]> = {
  bash: ['-c'], sh: ['-c'], zsh: ['-c'], ksh: ['-c'], dash: ['-c'], ash: ['-c'], fish: ['-c'],
  powershell: ['-c', '-command'], pwsh: ['-c', '-command'],
  cmd: ['/c'], wsl: ['-e', '--', '-c'],
};

/**
 * 展开 shell 包装的嵌套命令：`bash -c 'rm -rf /'` → 追加段 [rm, -rf, /]。
 * 递归展开（深度上限 3），确保嵌套包装（wsl bash -c …）也被检查。
 */
export function expandSegments(segments: string[][]): string[][] {
  const out: string[][] = [];
  let queue: string[][] = segments;
  for (let depth = 0; depth < 3 && queue.length > 0; depth++) {
    const next: string[][] = [];
    for (const seg of queue) {
      out.push(seg);
      const base = baseCommand(seg);
      const flags = base ? SHELL_WRAPPERS[base] : undefined;
      if (!flags) continue;
      for (let i = 1; i < seg.length; i++) {
        if (!flags.some((fl) => seg[i].toLowerCase() === fl.toLowerCase())) continue;
        const script = seg.slice(i + 1).join(' ').trim();
        if (script.length > 0) next.push(...parseCommandSegments(script));
        break;
      }
    }
    queue = next;
  }
  return out;
}

// ── 结构化硬拒绝规则 ────────────────────────────────────────────────

export interface DenyRule {
  label: string;
  /** 对命令的每个基础命令段判定；命中任一即拒绝 */
  check(seg: string[]): boolean;
}

export const HARD_DENY_RULES: DenyRule[] = [
  {
    label: 'rm 根目录递归删除',
    check(seg) {
      const base = baseCommand(seg);
      if (base !== 'rm' && base !== 'rmdir' && base !== 'rm-rf') return false;
      return positionalArgs(seg).some(isRootPath);
    },
  },
  {
    label: 'Remove-Item 删盘根',
    check(seg) {
      if (baseCommand(seg) !== 'remove-item') return false;
      return positionalArgs(seg).some(isRootPath);
    },
  },
  {
    label: 'del/rd 盘根删除',
    check(seg) {
      const base = baseCommand(seg);
      if (base !== 'del' && base !== 'rd' && base !== 'erase') return false;
      return positionalArgs(seg).some(isRootPath);
    },
  },
  {
    label: 'mkfs 格式化文件系统',
    check(seg) {
      const base = baseCommand(seg) ?? '';
      return base === 'mkfs' || base.startsWith('mkfs.');
    },
  },
  {
    label: 'dd 裸盘写入',
    check(seg) {
      if (baseCommand(seg) !== 'dd') return false;
      return positionalArgs(seg).some((a) => a.startsWith('if='));
    },
  },
  {
    label: 'format 格式化磁盘',
    check(seg) {
      if (baseCommand(seg) !== 'format') return false;
      return positionalArgs(seg).some((a) => /^[A-Za-z]:$/.test(a));
    },
  },
  {
    label: 'diskpart（磁盘分区操作）',
    check(seg) { return baseCommand(seg) === 'diskpart'; },
  },
  {
    label: 'vssadmin delete（删卷影副本）',
    check(seg) {
      if (baseCommand(seg) !== 'vssadmin') return false;
      return positionalArgs(seg).includes('delete');
    },
  },
  {
    label: 'bcdedit（引导配置篡改）',
    check(seg) { return baseCommand(seg) === 'bcdedit'; },
  },
  {
    label: 'reg delete HK（删注册表根键）',
    check(seg) {
      const base = baseCommand(seg);
      if (base !== 'reg') return false;
      const pos = positionalArgs(seg);
      return pos.includes('delete') && pos.some((a) => a.toUpperCase().startsWith('HK'));
    },
  },
  {
    label: 'cipher /w（擦除磁盘空闲空间）',
    check(seg) {
      if (baseCommand(seg) !== 'cipher') return false;
      return positionalArgs(seg).some((a) => a === '/w' || a.startsWith('/w:'));
    },
  },
  {
    label: 'fork 炸弹',
    check(seg) {
      return /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/.test(seg.join(' '));
    },
  },
];

/** 对整条命令做硬拒绝检查（含 shell 包装穿透），返回命中原因列表（空 = 放行） */
export function hardDenyCheck(command: string): string[] {
  const reasons: string[] = [];
  for (const seg of expandSegments(parseCommandSegments(command))) {
    for (const rule of HARD_DENY_RULES) {
      try {
        if (rule.check(seg)) reasons.push(rule.label);
      } catch {
        // 单条规则异常不阻断判定（防御）
      }
    }
  }
  return reasons;
}
