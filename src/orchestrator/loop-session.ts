/**
 * 会话 JSONL 清理（B2 拆出）——陪伴模式的对话文件痕迹处理。
 *
 * 原为 loop.ts 的三个私有方法：removeLastRoundFromJsonl / cleanCompanionJsonl /
 * removeTriggerFromJsonl（~185 行）。纯文件操作，唯一依赖是 sessionDir，
 * 故拆为模块级函数；AgentLoop 保留同名薄壳方法（router.ts 经 loop 调用）。
 * 行为零变更：纯搬移，仅 `this.sessionDir` 参数化为 `sessionDir`。
 */
import path from 'node:path';

/**
 * 陪伴模式：从 JSONL 中移除本轮工具调用完整回合。
 * 找到最后一条 user 文本消息，从它开始截断文件——
 * 整个工具调用回合（user → tool_use → tool_result → 跟进文本）都不留痕迹。
 */
export async function removeLastRoundFromJsonl(sessionDir: string): Promise<void> {
  try {
    const jsonlPath = path.join(sessionDir, 'conversation.jsonl');
    const fsSync = await import('node:fs');
    if (!fsSync.existsSync(jsonlPath)) return;

    const content = fsSync.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    // 从末尾往前找本轮第一个 tool_use assistant 消息
    let firstToolUse = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role === 'assistant' && Array.isArray(msg.content) &&
            msg.content.some((b: any) => b.type === 'tool_use')) {
          firstToolUse = i;
        } else if (firstToolUse !== -1) {
          break; // 遇到非 tool_use 消息，本轮的 tool 区域结束
        }
      } catch { /* skip */ }
    }

    if (firstToolUse === -1) return;

    // 从 tool_use 往前找到触发它的 user 文本消息（排除 tool_result）
    let cutIndex = firstToolUse;
    for (let i = firstToolUse - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role === 'user') {
          const c = msg.content;
          if (!Array.isArray(c) || !c.some((b: any) => b.type === 'tool_result')) {
            cutIndex = i;
            break;
          }
        }
      } catch { /* skip */ }
    }

    // 截断：保留 cutIndex 之前的所有行
    const kept = lines.slice(0, cutIndex);
    const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
    fsSync.writeFileSync(jsonlPath, newContent, 'utf-8');
  } catch { /* 文件操作失败不阻塞 */ }
}

/**
 * 陪伴模式工具调用清理：
 * - companion_mode 切换 → 剥离工具痕迹，保留 LLM 文本
 * - 其他工具 → 整轮砍掉（原有行为）
 * - 找不到触发消息（跨 session） → 处理整个文件
 */
export async function cleanCompanionJsonl(sessionDir: string): Promise<void> {
  try {
    const jsonlPath = path.join(sessionDir, 'conversation.jsonl');
    const fsSync = await import('node:fs');
    if (!fsSync.existsSync(jsonlPath)) return;

    const content = fsSync.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    // 从末尾往前找最后一条纯文本 user 消息
    let triggerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role !== 'user') continue;
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
        if (blocks.every((b: any) => b.type === 'tool_result')) continue;
        triggerIdx = i;
        break;
      } catch { /* skip */ }
    }

    // 检查是否有 companion_mode 工具（跨 session 时从 0 开始扫描）
    let hasCompanionModeTool = false;
    const scanFrom = triggerIdx === -1 ? 0 : triggerIdx;
    for (let i = scanFrom; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role !== 'assistant') continue;
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
        if (blocks.some((b: any) => b.type === 'tool_use' && b.name === 'companion_mode')) {
          hasCompanionModeTool = true;
          break;
        }
      } catch { /* skip */ }
    }

    // companion_mode 切换：剥离 tool 痕迹，保留 LLM 文本
    if (hasCompanionModeTool) {
      const processFrom = triggerIdx === -1 ? 0 : triggerIdx + 1;
      const kept: string[] = [];
      for (let i = 0; i < processFrom; i++) kept.push(lines[i]);
      for (let i = processFrom; i < lines.length; i++) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role === 'user') {
            const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
            if (blocks.some((b: any) => b.type === 'tool_result')) continue;
            kept.push(lines[i]);
            continue;
          }
          if (msg.role === 'assistant') {
            const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
            // 跳过包含 companion_mode tool_use 的消息（确认语如 "好的，进入陪伴模式。"）
            if (blocks.some((b: any) => b.type === 'tool_use' && b.name === 'companion_mode')) continue;
            const textBlocks = blocks.filter((b: any) => b.type === 'text');
            if (textBlocks.length === 0) continue;
            kept.push(JSON.stringify({
              role: 'assistant',
              content: textBlocks.length === 1 ? textBlocks[0] : textBlocks,
            }));
            continue;
          }
          kept.push(lines[i]);
        } catch { /* skip */ }
      }
      fsSync.writeFileSync(jsonlPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
      return;
    }

    // 普通工具：整轮砍掉
    if (triggerIdx !== -1) {
      const kept = lines.slice(0, triggerIdx);
      fsSync.writeFileSync(jsonlPath, kept.length ? kept.join('\n') + '\n' : '', 'utf-8');
    }
  } catch { /* 文件操作失败不阻塞 */ }
}

/**
 * 陪伴模式定时任务专用：只移除触发提示词和工具链，保留模型自然回复。
 * 效果：模型看起来像是"主动"搭话，而非响应系统指令。
 */
export async function removeTriggerFromJsonl(sessionDir: string): Promise<void> {
  try {
    const jsonlPath = path.join(sessionDir, 'conversation.jsonl');
    const fsSync = await import('node:fs');
    if (!fsSync.existsSync(jsonlPath)) return;

    const content = fsSync.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    // 从末尾找最后一条 user 文本消息（触发提示词）
    let triggerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role !== 'user') continue;
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
        if (blocks.every((b: any) => b.type === 'tool_result')) continue;
        triggerIdx = i;
        break;
      } catch { /* skip */ }
    }

    if (triggerIdx === -1) return;

    // 收集要移除的索引：触发词 + 之后所有的 tool_use / tool_result
    const removeIndices = new Set<number>();
    removeIndices.add(triggerIdx);

    for (let i = triggerIdx + 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]);
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];

        if (msg.role === 'assistant' && blocks.some((b: any) => b.type === 'tool_use')) {
          removeIndices.add(i);
        }
        if (msg.role === 'user' && blocks.every((b: any) => b.type === 'tool_result')) {
          removeIndices.add(i);
        }
      } catch { /* skip */ }
    }

    const kept = lines.filter((_, i) => !removeIndices.has(i));
    const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
    fsSync.writeFileSync(jsonlPath, newContent, 'utf-8');
  } catch { /* 文件操作失败不阻塞 */ }
}
