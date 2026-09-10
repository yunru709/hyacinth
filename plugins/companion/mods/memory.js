/**
 * companion 陪伴记忆 ContextSource（mods/memory.js）。
 *
 * 由 companion 插件的 architecture 声明接管出厂 source:companion_memory：
 * 插件启用时经分发表 registerSource 同名覆盖内置源（逻辑与出厂一致 ——
 * 按当前陪伴 Router 角色读 ~/.agent/companion/<name>/memory.md），
 * 未启用时走出厂实现（architecture 声明不生效）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default {
  name: 'companion_memory',
  strategy: 'always_inline',
  cacheability: 'manifest',
  description: '陪伴模式专属记忆（按角色隔离）',
  getContent: () => {
    // 当前陪伴角色名来自 context.mode 服务（router.activeCompanionName），
    // 此处经最小全局读取规避跨模块依赖：读 .last-character 作为回退。
    const name = readActiveCompanionName();
    if (!name) return '';
    const file = path.join(os.homedir(), '.agent', 'companion', name, 'memory.md');
    try {
      const content = fs.readFileSync(file, 'utf-8');
      return content.trim() ? `<!-- 陪伴角色记忆（${name}）-->\n\n${content}` : '';
    } catch {
      return ''; // 文件不存在，无记忆
    }
  },
};

/** 读取当前活跃陪伴角色名（.last-character；与出厂 context-sources 同源） */
function readActiveCompanionName() {
  try {
    return fs.readFileSync(
      path.join(os.homedir(), '.agent', 'companion', '.last-character'), 'utf-8',
    ).trim();
  } catch {
    return '';
  }
}
