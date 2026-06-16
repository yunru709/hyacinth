import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { loadPrompt, clearPromptCache, renderPrompt } from '../prompts/loader.js';

const logger = createLogger('env-collector');

export interface SystemEnvInfo {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: string;
  gpu: string;
  python: string;
  nodeVersion: string;
  shell: string;
}

let cachedInfo: SystemEnvInfo | null = null;

function safeExec(cmd: string, fallback: string = '(未检测到)'): string {
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result || fallback;
  } catch {
    return fallback;
  }
}

function detectGPU(): string {
  if (process.platform === 'win32') {
    // ── 方案1: nvidia-smi — N 卡优先，VRAM 准确不溢出（Win32_VideoController.AdapterRAM 是 uint32，>4GB 截断）──
    const nvidiaOutput = safeExec(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader',
      '',
    );
    if (nvidiaOutput && nvidiaOutput !== '(未检测到)') {
      const firstLine = nvidiaOutput.split('\n')[0].trim();
      const parts = firstLine.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        const vramMatch = parts[1].match(/(\d+)/);
        const vramMB = vramMatch ? parseInt(vramMatch[1], 10) : 0;
        if (vramMB > 0) {
          const vramGB = (vramMB / 1024).toFixed(1);
          return `${parts[0]} (VRAM ${vramGB} GB)`;
        }
      }
      return firstLine;
    }

    // ── 方案2: Get-CimInstance（没 N 卡驱动时回退，如 AMD/Intel 独显）──
    const psCmd = 'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)||$($_.AdapterRAM)" }';
    const output = safeExec(`powershell -Command "${psCmd}"`, '');
    if (output && output !== '(未检测到)') {
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      const realCards = lines.filter(l =>
        !l.includes('Microsoft Basic') &&
        !l.includes('Microsoft Remote') &&
        !l.includes('Microsoft Hyper-V') &&
        !l.includes('Remote Display'),
      );
      for (const line of [...realCards, ...lines]) {
        const sepIdx = line.indexOf('||');
        const name = sepIdx >= 0 ? line.substring(0, sepIdx).trim() : line.trim();
        const vramStr = sepIdx >= 0 ? line.substring(sepIdx + 2).trim() : '';
        const vramBytes = parseInt(vramStr, 10);
        if (vramBytes && !isNaN(vramBytes) && vramBytes > 0 && vramBytes < 1_000_000_000_000) {
          const vramGB = (vramBytes / 1024 / 1024 / 1024).toFixed(1);
          return `${name} (VRAM ${vramGB} GB)`;
        }
        if (name && name !== '(未检测到)') {
          return name;
        }
      }
    }
  }

  if (process.platform === 'linux') {
    const output = safeExec('lspci | grep -i vga', '');
    if (output) {
      const nameMatch = output.match(/:\s*(.+)/);
      return nameMatch ? nameMatch[1].trim() : output;
    }
    const nvidiaOutput = safeExec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', '');
    if (nvidiaOutput && nvidiaOutput !== '(未检测到)') {
      return nvidiaOutput.split('\n')[0].trim().replace(',', ' (VRAM') + ')';
    }
  }

  if (process.platform === 'darwin') {
    return safeExec('system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" | head -1 | sed "s/.*: //"');
  }

  return '(未检测到)';
}

function detectPython(): string {
  for (const cmd of ['python3 --version', 'python --version']) {
    const result = safeExec(cmd, '');
    if (result && result !== '(未检测到)') {
      return result.replace(/^Python\s+/i, '').trim();
    }
  }
  return '(未安装)';
}

function detectShell(): string {
  if (process.platform === 'win32') {
    const psVersion = safeExec('powershell -Command "$PSVersionTable.PSVersion.ToString()"', '');
    if (psVersion && psVersion !== '(未检测到)') {
      return `PowerShell ${psVersion}`;
    }
    return 'Command Prompt';
  }
  return process.env.SHELL || '/bin/sh';
}

function detectCPUModel(): string {
  if (process.platform === 'win32') {
    const name = safeExec(
      'powershell -Command "(Get-CimInstance Win32_Processor).Name"',
      '',
    ).replace(/[\r\n]+/g, '').trim();
    if (name && name !== '(未检测到)') return name;
  }
  // Linux/macOS fallback: Node.js 的 os.cpus()[0].model 已够用
  const firstCpu = os.cpus()[0];
  return firstCpu?.model?.trim() || os.arch();
}

export function collectSystemInfo(): SystemEnvInfo {
  if (cachedInfo) return cachedInfo;

  const totalMemBytes = os.totalmem();
  const totalMemGB = (totalMemBytes / 1024 / 1024 / 1024).toFixed(1);

  const osName = process.platform === 'win32'
    ? safeExec(
        'powershell -Command "(Get-CimInstance Win32_OperatingSystem).Caption"',
        os.type(),
      ).replace(/[\r\n]+/g, '').trim()
    : `${os.type()} ${os.release()}`;

  cachedInfo = {
    os: osName,
    arch: os.arch(),
    cpuModel: detectCPUModel(),
    cpuCores: os.cpus().length,
    totalMemoryGB: totalMemGB,
    gpu: detectGPU(),
    python: detectPython(),
    nodeVersion: process.version,
    shell: detectShell(),
  };

  logger.info('System environment collected', { ...cachedInfo });
  return cachedInfo;
}

export function getSystemInfo(): SystemEnvInfo | null {
  return cachedInfo;
}

/** 渠道信息（会注入到 System Prompt 的 environment section） */
export interface ChannelsInfo {
  /** 渠道名称（如 'feishu'） */
  name: string;
  /** 渠道显示名称（如 '飞书'） */
  displayName: string;
  /** 连接模式 */
  connectionMode: string;
  /** DM 策略 */
  dmPolicy: string;
  /** 群组策略 */
  groupPolicy: string;
  /** 群聊是否需要 @提及 */
  requireMention: boolean;
  /** 当前连接的 sessionId */
  sessionId?: string;
  /** 是否群聊 */
  isGroup?: boolean;
}

export function formatEnvInfo(info: SystemEnvInfo, channels?: ChannelsInfo[]): string {
  return buildEnvironmentSection(info, channels);
}

// ── 拼接式 environment 构建 ─────────────────────────────────────────

/**
 * 构建 environment section 内容。
 * 拼接顺序：静态模板文件 → 动态系统信息 → 渠道信息。
 *
 * 静态模板文件位于 prompts/environment/*.md，
 * 外部覆盖路径：.agent/prompts/environment/*.md。
 * 支持 {{cwd}} 模板变量。
 */
export function buildEnvironmentSection(
  info: SystemEnvInfo,
  channels?: ChannelsInfo[],
  options?: { cwd?: string },
): string {
  const parts: string[] = [];

  // 1. 静态模板文件
  const staticContent = loadEnvironmentStaticFiles(options?.cwd);
  if (staticContent) {
    parts.push(staticContent);
  }

  // 2. 动态系统信息
  parts.push(formatDynamicEnvInfo(info));

  // 3. 渠道信息
  if (channels && channels.length > 0) {
    parts.push(formatChannelsInfo(channels));
  }

  return parts.filter(Boolean).join('\n\n');
}

// ── 动态系统信息 ──

function formatDynamicEnvInfo(info: SystemEnvInfo): string {
  const lines = [
    `运行环境:`,
    `- 操作系统: ${info.os}`,
    `- 架构: ${info.arch}`,
    `- CPU: ${info.cpuModel} (${info.cpuCores} 核)`,
    `- 内存: ${info.totalMemoryGB} GB`,
    `- 显卡: ${info.gpu}`,
    `- Python: ${info.python}`,
    `- Node.js: ${info.nodeVersion}`,
    `- Shell: ${info.shell}`,
  ];
  return lines.join('\n');
}

// ── 渠道信息 ──

function formatChannelsInfo(channels: ChannelsInfo[]): string {
  const lines = ['已连接的渠道:'];

  for (const ch of channels) {
    const connInfo = ch.isGroup ? '群聊' : '私聊';
    lines.push(`- ${ch.displayName} (${ch.name}) [${connInfo}]:`);
    lines.push(`  连接模式: ${ch.connectionMode}`);
    lines.push(`  DM策略: ${ch.dmPolicy} | 群组策略: ${ch.groupPolicy}`);
    lines.push(`  群聊需@提及: ${ch.requireMention ? '是' : '否'}`);
    if (ch.sessionId) {
      lines.push(`  当前会话: ${ch.sessionId}`);
    }
    lines.push(`  回复规则: 通过该渠道的 reply() 方法回复用户，每轮对话必须回复`);
  }

  return lines.join('\n');
}

// ── 静态模板文件加载 ──

/**
 * 通过统一的 loadPrompt 系统加载 prompts/environment/ 下的静态内容。
 * 使用 skipCache: true 实现热加载 —— 编辑 .agent/prompts/environment/*.md 后无需重启、无需编译。
 *
 * 查找顺序（由 loadPrompt 统一管理）：
 * 1. .agent/prompts/environment/{name}.md（用户覆盖，热编辑）
 * 2. dist/prompts/environment/{name}.md（内置默认）
 *
 * 支持 {{cwd}} 模板变量（此处手动渲染）。
 */
function loadEnvironmentStaticFiles(cwd?: string): string | null {
  // 环境和渠道相关的提示文件，按需扩展此列表
  const envFiles = ['environment'];

  const contents: string[] = [];
  for (const name of envFiles) {
    try {
      let content = loadPrompt(`environment/${name}`, { skipCache: true });
      // 手动渲染 {{cwd}} 和 {{globalConfigDir}}（runtime:env 不走 resolveTemplate，需要自行处理）
      const renderVars: Record<string, string> = {};
      if (cwd) renderVars.cwd = cwd;
      renderVars.globalConfigDir = path.join(os.homedir(), '.agent').replace(/\\/g, '/');
      content = renderPrompt(content, renderVars);
      content = content.trim();
      if (content) {
        contents.push(content);
      }
    } catch {
      // 文件不存在则跳过
    }
  }

  return contents.length > 0 ? contents.join('\n\n') : null;
}
