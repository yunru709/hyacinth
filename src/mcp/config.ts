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

/**
 * MCPConfigLoader — 从配置文件加载 MCP Server 配置
 *
 * 查找顺序：
 * 1. ~/.agent/mcp.json（用户级全局配置）
 * 2. <cwd>/.mcp.json（项目级配置）
 */
export class MCPConfigLoader {
  /** 从配置目录加载 MCP 配置 */
  async load(projectDir: string): Promise<MCPConfig[]> {
    // 用户级全局配置优先
    const userConfigPath = path.join(os.homedir(), '.agent', 'mcp.json');
    try {
      const content = await fs.readFile(userConfigPath, 'utf-8');
      const config = JSON.parse(content);
      if (config.mcpServers && typeof config.mcpServers === 'object') {
        return this.parseConfig(
          config.mcpServers as Record<string, unknown>,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`failed to load MCP config from ~/.agent/mcp.json: ${msg}`);
    }

    // 项目级 .mcp.json 作为补充
    try {
      const projectPath = path.join(projectDir, '.mcp.json');
      const content = await fs.readFile(projectPath, 'utf-8');
      const config = JSON.parse(content);
      if (config.mcpServers && typeof config.mcpServers === 'object') {
        return this.parseConfig(
          config.mcpServers as Record<string, unknown>,
        );
      }
    } catch (err) {
      // 项目级配置不存在是正常的，不打印警告
    }

    return [];
  }

  /** 解析 mcpServers 配置对象 */
  private parseConfig(mcpServers: Record<string, unknown>): MCPConfig[] {
    const configs: MCPConfig[] = [];
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (typeof serverConfig !== 'object' || serverConfig === null) continue;
      const cfg = serverConfig as Record<string, unknown>;
      if (cfg._disabled) continue;
      // 校验 command：拒绝危险命令
      const command = cfg.command as string | undefined;
      if (command) {
        const baseName = command.split(/[/\\]/).pop()?.toLowerCase() ?? command.toLowerCase();
        if (BLOCKED_COMMANDS.has(baseName)) {
          logger.error(`MCP Server "${name}" blocked: command "${command}" is not allowed (dangerous shell command)`);
          continue;
        }
      }

      configs.push({
        name,
        command,
        args: cfg.args as string[] | undefined,
        url: cfg.url as string | undefined,
        env: cfg.env as Record<string, string> | undefined,
        headers: cfg.headers as Record<string, string> | undefined,
        packageType: cfg.packageType as 'npm' | 'python' | undefined,
        package: cfg.package as string | undefined,
        packageVersion: cfg.packageVersion as string | undefined,
        connectTimeout: cfg.connectTimeout as number | undefined,
        callTimeout: cfg.callTimeout as number | undefined,
      });
    }
    return configs;
  }
}
