import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

// ============================================================================
// 类型定义
// ============================================================================

/** 已扫描的模型信息 */
export interface ModelInfo {
  /** 文件名（不含路径），如 llama-3-8b-q4_k_m.gguf */
  name: string;
  /** 完整路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 模型格式，如 'gguf-v3' 或 'unknown' */
  format: string;
  /** 修改时间 ISO 字符串 */
  modifiedAt: string;
}

// ============================================================================
// 常量
// ============================================================================

/** GGUF 文件魔数: "GGUF" 在 little-endian 下的 uint32 值 */
const GGUF_MAGIC = 0x46554747;

/** GGUF 文件后缀 */
const GGUF_EXT = '.gguf';

// ============================================================================
// ModelStore
// ============================================================================

export class ModelStore {
  private models: ModelInfo[] = [];
  private modelsDir: string;

  /**
   * @param modelsDir 模型文件存放目录，默认 './models'
   */
  constructor(modelsDir?: string) {
    this.modelsDir = path.resolve(modelsDir ?? './models');
  }

  // ==========================================================================
  // 公共 API
  // ==========================================================================

  /**
   * 递归扫描 modelsDir 下的 .gguf 文件，填充内部索引。
   * 结果按文件名（name）字母序排列。
   *
   * @returns 扫描到的模型列表
   */
  async scan(): Promise<ModelInfo[]> {
    const found: ModelInfo[] = [];

    // 递归遍历目录
    await this.scanDir(this.modelsDir, found);

    // 按 name 字母序排列
    found.sort((a, b) => a.name.localeCompare(b.name));

    this.models = found;
    return this.models;
  }

  /**
   * 校验单个 GGUF 文件。
   *
   * 检查内容：
   * - 文件可读（access R_OK）
   * - 文件大小 > 0（stat）
   * - GGUF 文件头魔数正确（前 4 字节 = "GGUF"）
   *
   * @param modelPath 模型文件路径
   * @returns 校验通过返回 true，否则 false
   */
  async verify(modelPath: string): Promise<boolean> {
    try {
      // 1. 检查文件可读
      await fs.access(modelPath, constants.R_OK);
    } catch {
      return false;
    }

    try {
      // 2. 检查文件大小 > 0
      const stat = await fs.stat(modelPath);
      if (stat.size === 0) {
        return false;
      }

      // 3. 读取前 8 字节校验魔数
      const fd = await fs.open(modelPath, 'r');
      const buf = Buffer.alloc(8);
      await fd.read(buf, 0, 8, 0);
      await fd.close();

      const magic = buf.readUInt32LE(0);
      return magic === GGUF_MAGIC;
    } catch {
      return false;
    }
  }

  /**
   * 返回已扫描的模型列表（按名称排序）。
   *
   * @returns 模型信息数组，未扫描时返回空数组
   */
  list(): ModelInfo[] {
    return this.models;
  }

  /**
   * 按名称查找模型。
   *
   * 支持模糊匹配：
   * - 传入 "llama-3-8b" 会匹配 "llama-3-8b.gguf"
   * - 传入 "llama-3-8b.gguf" 精确匹配
   *
   * @param name 模型名称（可带或不带 .gguf 后缀）
   * @returns 匹配的 ModelInfo，未找到返回 undefined
   */
  findByName(name: string): ModelInfo | undefined {
    // 如果入参已带 .gguf 后缀，直接精确匹配
    if (name.endsWith(GGUF_EXT)) {
      return this.models.find((m) => m.name === name);
    }

    // 否则追加 .gguf 后匹配
    const fullName = name + GGUF_EXT;
    return this.models.find((m) => m.name === fullName);
  }

  /**
   * 是否有至少一个可用模型。
   *
   * @returns 已扫描到至少一个模型返回 true
   */
  hasModels(): boolean {
    return this.models.length > 0;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 递归扫描目录，收集 .gguf 文件信息。
   *
   * @param dir 当前扫描目录
   * @param results 结果收集数组
   */
  private async scanDir(dir: string, results: ModelInfo[]): Promise<void> {
    let entries: Dirent[];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在或无权限，静默跳过
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归进入子目录
        await this.scanDir(fullPath, results);
      } else if (entry.isFile() && path.extname(entry.name) === GGUF_EXT) {
        // 收集 .gguf 文件
        const info = await this.collectFileInfo(fullPath, entry.name);
        if (info) {
          results.push(info);
        }
      }
    }
  }

  /**
   * 收集单个 .gguf 文件的信息。
   *
   * @param filePath 完整文件路径
   * @param fileName 文件名（不含路径）
   * @returns ModelInfo，失败返回 undefined
   */
  private async collectFileInfo(
    filePath: string,
    fileName: string,
  ): Promise<ModelInfo | undefined> {
    try {
      const stat = await fs.stat(filePath);

      // 检测 GGUF 版本号
      const format = await this.detectGgufVersion(filePath);

      return {
        name: fileName,
        path: filePath,
        size: stat.size,
        format,
        modifiedAt: stat.mtime.toISOString(),
      };
    } catch {
      // 文件状态读取失败，跳过
      return undefined;
    }
  }

  /**
   * 读取文件头检测 GGUF 版本号。
   *
   * 前 4 字节：魔数 "GGUF"
   * 第 5-8 字节（uint32 LE）：版本号
   *
   * @param filePath 文件路径
   * @returns 格式字符串，如 'gguf-v3' 或 'unknown'
   */
  private async detectGgufVersion(filePath: string): Promise<string> {
    try {
      const fd = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(8);
      await fd.read(buf, 0, 8, 0);
      await fd.close();

      const magic = buf.readUInt32LE(0);
      const version = buf.readUInt32LE(4);

      if (magic === GGUF_MAGIC) {
        return `gguf-v${version}`;
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}