import os from 'node:os';
import path from 'node:path';
import { execSync, exec } from 'node:child_process';
/**
 * 手动包一层 Promise —— 不要用 promisify(exec)。
 *
 * 安全内核（kernel/security/bootstrap.ts → guards.ts 的 guardChildProcess）会
 * **原地替换** child_process.exec 为守卫包装函数，而包装函数丢掉了
 * util.promisify.custom 符号 ⇒ promisify 退化成通用版 ⇒ resolve 出来的是回调第一个
 * 参数（stdout 字符串）而不是 { stdout, stderr } ⇒ `const { stdout } = await ...`
 * 恒为 undefined ⇒ 每个异步探测都抛 "Cannot read properties of undefined (reading
 * 'trim')"，GPU/Python/Shell 全灭，坏值再被缓存到进程结束。
 *
 * 走 callback 形态既避开该陷阱，又让探测真正经过内核的策略检查（建前检查 + env 改写）。
 */
const execAsync = (
  cmd: string,
  options: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    exec(cmd, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
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

/**
 * 单次 shell 探测超时（ms）。
 * 原先 5000 太紧：冷启动的 nvidia-smi（Optimus 笔记本独显休眠时唤醒）与
 * PowerShell 首启都可能超过 5s，一旦超时就静默退化成 fallback，且结果被永久缓存。
 */
const SHELL_TIMEOUT_MS = 15000;

function safeExec(cmd: string, fallback: string = '(未检测到)'): string {
  try {
    // windowsHide: true 不能省 —— 本进程通常没有控制台，不开此标志时 Windows 会尝试
    // 为子进程新建控制台，execSync 直接失败（catch 吞掉 ⇒ 静默降级）。
    // 实测同一进程内：带此标志的 async 版能跑通 python/shell 探测，不带此标志的
    // sync 版全部阵亡（GPU/CPU/Python/Shell 一起变成 fallback）。
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: SHELL_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
    return result || fallback;
  } catch (err) {
    logger.warn('shell probe failed', { cmd, err: (err as Error).message });
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
    // 命令里禁止出现嵌套双引号 / $() / ||：execSync 经 cmd.exe 层，内层引号会被吃掉。
    // 实测 `ForEach-Object { "$($_.Name)||$($_.AdapterRAM)" }` 在任何 Windows 上都报
    // TerminatorExpectedAtEndOfString ⇒ 这条兜底路径其实从未生效过。
    const psCmd = 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name';
    const output = safeExec(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, '');
    if (output && output !== '(未检测到)') {
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      const realCards = lines.filter(l =>
        !l.includes('Microsoft Basic') &&
        !l.includes('Microsoft Remote') &&
        !l.includes('Microsoft Hyper-V') &&
        !l.includes('Remote Display'),
      );
      // 只取显卡名：VRAM 交给 nvidia-smi（AdapterRAM 是 uint32，>4GB 会截断，不可信）
      if (realCards.length > 0) return realCards[0];
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

/**
 * 清空进程级缓存。
 * 首次探测若赶上瞬时失败（超时/冷启动），旧实现会把坏值缓存到进程死亡为止 ⇒
 * 这里给出重采入口，避免一次失手永久污染。
 */
export function resetSystemInfoCache(): void {
  cachedInfo = null;
}

// ── 异步并行采集（启动路径用：不阻塞 UI，首次 compose 时经 getContent await）──

/** 异步执行 shell 命令（并行安全，超时兜底），失败返回 fallback */
async function safeExecAsync(cmd: string, fallback: string = '(未检测到)'): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, {
      encoding: 'utf-8',
      timeout: SHELL_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim() || fallback;
  } catch (err) {
    logger.warn('async shell probe failed', { cmd, err: (err as Error).message });
    return fallback;
  }
}

/** 解析 nvidia-smi 输出（返回 'Name (VRAM x.x GB)' 或 null） */
function parseNvidiaGpu(nvidiaOutput: string): string | null {
  if (!nvidiaOutput || nvidiaOutput === '(未检测到)') return null;
  const firstLine = nvidiaOutput.split('\n')[0].trim();
  const parts = firstLine.split(',').map((s) => s.trim());
  if (parts.length >= 2) {
    const vramMatch = parts[1].match(/(\d+)/);
    const vramMB = vramMatch ? parseInt(vramMatch[1], 10) : 0;
    if (vramMB > 0) {
      const vramGB = (vramMB / 1024).toFixed(1);
      return parts[0] + ' (VRAM ' + vramGB + ' GB)';
    }
  }
  return firstLine;
}

/** 解析 PowerShell Win32_VideoController 输出（每行一个显卡名；返回首个真实显卡或 null） */
function parsePowerShellGpu(output: string): string | null {
  if (!output || output === '(未检测到)') return null;
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const realCards = lines.filter(
    (l) =>
      !l.includes('Microsoft Basic') &&
      !l.includes('Microsoft Remote') &&
      !l.includes('Microsoft Hyper-V') &&
      !l.includes('Remote Display'),
  );
  // 只取显卡名：VRAM 交给 nvidia-smi（AdapterRAM 是 uint32，>4GB 会截断，不可信）
  return realCards[0] ?? null;
}

async function detectGpuAsync(): Promise<string> {
  if (process.platform === 'win32') {
    const nvidiaOutput = await safeExecAsync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader',
      '',
    );
    const parsed = parseNvidiaGpu(nvidiaOutput);
    if (parsed) return parsed;

    const psOutput = await safeExecAsync(
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
      '',
    );
    return parsePowerShellGpu(psOutput) ?? '(未检测到)';
  }

  if (process.platform === 'linux') {
    const lspciOut = await safeExecAsync('lspci | grep -i vga', '');
    if (lspciOut) {
      const nameMatch = lspciOut.match(/:\s*(.+)/);
      return nameMatch ? nameMatch[1].trim() : lspciOut;
    }
    const nvidiaOutput = await safeExecAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', '');
    const parsed = parseNvidiaGpu(nvidiaOutput);
    if (parsed) return parsed;
    return '(未检测到)';
  }

  if (process.platform === 'darwin') {
    return safeExecAsync('system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" | head -1 | sed "s/.*: //"');
  }

  return '(未检测到)';
}

async function detectPythonAsync(): Promise<string> {
  for (const cmd of ['python3 --version', 'python --version']) {
    const result = await safeExecAsync(cmd, '');
    if (result && result !== '(未检测到)') {
      return result.replace(/^Python\s+/i, '').trim();
    }
  }
  return '(未安装)';
}

/**
 * 异步并行采集系统环境信息（不阻塞启动路径）。
 * 与 collectSystemInfo 共享 cachedInfo：先到者填充，后到者直接返回缓存。
 */
export async function collectSystemInfoAsync(): Promise<SystemEnvInfo> {
  if (cachedInfo) return cachedInfo;

  const totalMemBytes = os.totalmem();
  const totalMemGB = (totalMemBytes / 1024 / 1024 / 1024).toFixed(1);

  const [osName, cpuModel, python, shell] = await Promise.all([
    process.platform === 'win32'
      ? safeExecAsync(
          'powershell -Command "(Get-CimInstance Win32_OperatingSystem).Caption"',
          os.type(),
        ).then((s) => s.replace(/[\r\n]+/g, '').trim())
      : Promise.resolve(os.type() + ' ' + os.release()),
    process.platform === 'win32'
      ? safeExecAsync(
          'powershell -Command "(Get-CimInstance Win32_Processor).Name"',
          '',
        ).then((s) => s.replace(/[\r\n]+/g, '').trim())
      : Promise.resolve((os.cpus()[0]?.model?.trim() ?? os.arch())),
    detectPythonAsync(),
    process.platform === 'win32'
      ? safeExecAsync('powershell -Command "$PSVersionTable.PSVersion.ToString()"', '').then((v) =>
          v && v !== '(未检测到)' ? 'PowerShell ' + v : 'Command Prompt',
        )
      : Promise.resolve(process.env.SHELL || '/bin/sh'),
  ]);

  const gpu = await detectGpuAsync();

  cachedInfo = {
    os: osName,
    arch: os.arch(),
    cpuModel,
    cpuCores: os.cpus().length,
    totalMemoryGB: totalMemGB,
    gpu,
    python,
    nodeVersion: process.version,
    shell,
  };

  logger.info('System environment collected', { ...cachedInfo });
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
