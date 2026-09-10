import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MCPConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('mcp:config');

/** 危险命令黑名单：这些命令可用于执行任意代码 */
const BLOCKED_COMMANDS = new Set([
  'cmd.exe', 'cmd',
  'powershell', 'pwsh',
  'bash', 'sh', 'zsh', 'fish',
  'wscript', 'cscript',
]);

/** 配置文件来源标记 */
export type MCPConfigScope = 'user' | 'project' | 'project-agent';

export interface MCPConfigEntry {
  /** 配置文件路径（唯一来源，setEnabled 依赖它回写） */
  file: string;
  scope: MCPConfigScope;
  name: string;
  /** 是否被 _disabled 标记关闭（关闭的条目仍会出现在 listEntries 中，但不会被 load() 采纳） */
  enabled: boolean;
  /** 原始配置对象（含 _disabled 等私有字段） */
  raw: Record<string, unknown>;
}

// ── 文件路径解析 ────────────────────────────────────────────────

/**
 * 返回所有候选 MCP 配置文件，按优先级从低到高：
 *   1. ~/.agent/mcp.json（用户级全局）
 *   2. <projectDir>/.mcp.json（项目级，Cursor/Claude 通用约定）
 *   3. <projectDir>/.agent/mcp.json（项目级，本仓库其余配置同样放在 .agent/ 下）
 *
 * 注意：早期实现里项目级配置是「全局存在则完全跳过」的补充，
 * 导致 <project>/.agent/mcp.json 形同虚设。现在统一合并，同名以高优先级为准。
 */
export function getMCPConfigPaths(projectDir: string): { file: string; scope: MCPConfigScope }[] {
  return [
    { file: path.join(os.homedir(), '.agent', 'mcp.json'), scope: 'user' },
    { file: path.join(projectDir, '.mcp.json'), scope: 'project' },
    { file: path.join(projectDir, '.agent', 'mcp.json'), scope: 'project-agent' },
  ];
}

/**
 * MCPConfigLoader — 从配置文件加载 MCP Server 配置
 *
 * 查找顺序（后者覆盖同名项）：
 * 1. ~/.agent/mcp.json（用户级全局配置）
 * 2. <projectDir>/.mcp.json（项目级配置）
 * 3. <projectDir>/.agent/mcp.json（项目级配置，与本仓库 .agent/ 约定一致）
 */
export class MCPConfigLoader {
  /**
   * 从配置目录加载 MCP 配置（自动跳过 _disabled 项）。
   * 三处来源合并，同名以优先级更高者为准。
   */
  async load(projectDir: string): Promise<MCPConfig[]> {
    const entries = await this.listEntries(projectDir);
    const byName = new Map<string, MCPConfigEntry>();
    for (const e of entries) {
      byName.set(e.name, e); // 后出现的（优先级更高）覆盖前一个
    }

    const configs: MCPConfig[] = [];
    for (const e of byName.values()) {
      if (!e.enabled) continue;
      const parsed = this.parseOne(e.name, e.raw);
      if (parsed) configs.push(parsed);
    }
    return configs;
  }

  /**
   * 列出所有配置文件中声明的 Server（**包含被 _disabled 的**），
   * 供 UI 展示与启停使用。按优先级顺序返回，同名时后者覆盖前者（保留最后一条）。
   */
  async listEntries(projectDir: string): Promise<MCPConfigEntry[]> {
    const candidates = getMCPConfigPaths(projectDir);
    const merged = new Map<string, MCPConfigEntry>();

    for (const { file, scope } of candidates) {
      let parsed: { mcpServers?: Record<string, unknown> };
      try {
        const content = await fs.readFile(file, 'utf-8');
        parsed = JSON.parse(content);
      } catch {
        // 文件不存在或格式错误都视为「无配置」，项目级缺失是正常现象
        continue;
      }
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') continue;

      for (const [name, serverConfig] of Object.entries(parsed.mcpServers)) {
        if (typeof serverConfig !== 'object' || serverConfig === null) continue;
        const raw = serverConfig as Record<string, unknown>;
        merged.set(name, {
          file,
          scope,
          name,
          enabled: raw._disabled !== true,
          raw,
        });
      }
    }

    return [...merged.values()];
  }

  /**
   * 启用/禁用某个 Server：在**声明它的那个配置文件**里写 `_disabled`。
   * 返回实际改动的文件；找不到该 Server 时抛错。
   */
  async setEnabled(projectDir: string, name: string, enabled: boolean): Promise<string> {
    const entries = await this.listEntries(projectDir);
    const target = entries.find((e) => e.name === name);
    if (!target) throw new Error(`MCP server "${name}" not found in any config file`);

    interface RawFile { mcpServers: Record<string, Record<string, unknown>> }
    const raw = JSON.parse(await fs.readFile(target.file, 'utf-8')) as RawFile;
    if (!raw.mcpServers || !raw.mcpServers[name]) {
      throw new Error(`MCP server "${name}" not found in ${target.file}`);
    }

    if (enabled) delete raw.mcpServers[name]._disabled;
    else raw.mcpServers[name]._disabled = true;

    await fs.writeFile(target.file, JSON.stringify(raw, null, 2), 'utf-8');
    logger.info(`MCP server "${name}" ${enabled ? 'enabled' : 'disabled'} in ${target.file}`);
    return target.file;
  }

  /** 解析单个 Server 配置（返回 null 表示被拦截/无效，应跳过） */
  private parseOne(name: string, serverConfig: Record<string, unknown>): MCPConfig | null {
    if (serverConfig._disabled) return null;
    // 校验 command：拒绝危险命令
    const command = serverConfig.command as string | undefined;
    if (command) {
      const baseName = command.split(/[/\\]/).pop()?.toLowerCase() ?? command.toLowerCase();
      if (BLOCKED_COMMANDS.has(baseName)) {
        logger.error(`MCP Server "${name}" blocked: command "${command}" is not allowed (dangerous shell command)`);
        return null;
      }
    }

    return {
      name,
      command,
      args: serverConfig.args as string[] | undefined,
      url: serverConfig.url as string | undefined,
      env: serverConfig.env as Record<string, string> | undefined,
      headers: serverConfig.headers as Record<string, string> | undefined,
      packageType: serverConfig.packageType as 'npm' | 'python' | undefined,
      package: serverConfig.package as string | undefined,
      packageVersion: serverConfig.packageVersion as string | undefined,
      connectTimeout: serverConfig.connectTimeout as number | undefined,
      callTimeout: serverConfig.callTimeout as number | undefined,
    };
  }

  /** 解析 mcpServers 配置对象（保留以兼容外部调用） */
  parseConfig(mcpServers: Record<string, unknown>): MCPConfig[] {
    const configs: MCPConfig[] = [];
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (typeof serverConfig !== 'object' || serverConfig === null) continue;
      const parsed = this.parseOne(name, serverConfig as Record<string, unknown>);
      if (parsed) configs.push(parsed);
    }
    return configs;
  }
}
