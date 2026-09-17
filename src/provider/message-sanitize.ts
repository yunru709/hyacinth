// ============================================================
// 报文序列兜底清理 —— OpenAI 兼容系厂商（deepseek/openai/local 等）专用
// ============================================================
// 背景（真实事故）：会话历史里出现过「无主的 tool_result」——即一条
// role='tool' 消息，它前面那条 assistant 消息只有 thinking/text，没有任何
// tool_calls（对应 id 在全量历史里查不到 tool_use）。成因是写入侧某条路径
// （中断 / 风暴抑制 LoopGuard / 历史重写）与 assistant 落盘不同步。
//
// 后果：Anthropic 系宽容，OpenAI 系严格校验 —— DeepSeek 直接 400
//   Messages with role 'tool' must be a response to a preceding message
//   with 'tool_calls'
// 整个会话从此在严格厂商上不可用（只有换会话才能恢复）。
//
// 本模块在**发请求前**做最后一道兜底：丢弃无主 tool 消息，保证序列合法。
// 这是防御性的"读侧"修复——不依赖写入侧是否已修好，历史脏数据的旧会话
// 也能立刻恢复可用。
// ============================================================

/** 最小结构约束（OpenAI SDK 的消息类型是联合类型，这里只取需要的字段） */
interface ToolMessageLike {
  role: string;
  tool_call_id?: unknown;
  tool_calls?: unknown;
}

/**
 * 丢弃没有对应 assistant tool_calls 的 tool 消息。
 *
 * 规则（对齐 OpenAI 校验语义）：
 *   - assistant(tool_calls) 打开一组待回应的调用 id；
 *   - 紧随其后的 role='tool' 消息必须命中这组 id，命中后消费掉该 id；
 *   - 遇到新的 user/system 轮次即关闭未匹配的调用，其后的 tool 消息即为孤儿 → 丢弃。
 *
 * 入参出参类型一致（泛型透传），调用方可直接 return 本函数结果。
 */
export function dropOrphanToolMessages<T>(messages: T[]): T[] {
  const out: T[] = [];
  // 当前"已打开、等待 tool 回应"的调用 id 集合
  let openIds = new Set<string>();

  for (const raw of messages) {
    const msg = raw as unknown as ToolMessageLike;

    if (msg.role === 'assistant') {
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      openIds = new Set(
        calls
          .map((c) => (c as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );
      out.push(raw);
      continue;
    }

    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      // 无 id 或未被任何 assistant tool_calls 打开 → 孤儿，丢弃（否则严格厂商整体 400）
      if (!id || !openIds.has(id)) continue;
      openIds.delete(id);
      out.push(raw);
      continue;
    }

    // 其余角色（user / system / developer）→ 新一轮开始，关闭未匹配的调用。
    // 注意：assistant 之外的轮次边界处，未消费的 id 就此作废 —— 之后出现的
    // 同 id tool 消息属于错位，不应再被接受。
    openIds = new Set();
    out.push(raw);
  }

  return out;
}

/**
 * 剥离**未被回应**的 assistant tool_calls（孤儿 tool_calls）。
 *
 * 与 dropOrphanToolMessages 互为镜像：后者治「tool 找不到主」，本函数治
 * 「主找不到 tool」——assistant 声明了调用，但整段历史里没有任何 tool 消息回应它。
 * 严格厂商据此整请求 400：
 *   "An assistant message with 'tool_calls' must be followed by tool messages
 *    responding to each 'tool_call_id'"
 *
 * 处理：剥掉未被回应的 tool_calls 条目（保留该消息的其它内容）；若剥完整条已无
 * 内容则丢弃。同为**读侧兜底**（不改磁盘），历史脏数据发请求前自愈。
 */
export function dropOrphanToolCalls<T>(messages: T[]): T[] {
  const answered = new Set<string>();
  let sawToolCalls = false;
  for (const raw of messages) {
    const m = raw as unknown as ToolMessageLike;
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id) {
      answered.add(m.tool_call_id);
    }
    if (Array.isArray(m.tool_calls)) sawToolCalls = true;
  }
  // 常见路径：整段没有 tool_calls → 无需处理
  if (!sawToolCalls) return messages;

  const out: T[] = [];
  for (const raw of messages) {
    const m = raw as unknown as ToolMessageLike;
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : null;
    if (m.role !== 'assistant' || !calls) { out.push(raw); continue; }

    const kept = calls.filter((c) => {
      const id = (c as { id?: unknown } | null)?.id;
      return typeof id === 'string' && answered.has(id);
    });
    if (kept.length === calls.length) { out.push(raw); continue; }

    // 有孤儿 tool_calls → 剥掉；剥完无内容则整条丢弃
    const rec = raw as unknown as { content?: unknown };
    const hasContent = rec.content !== undefined && rec.content !== null && rec.content !== '';
    if (kept.length === 0 && !hasContent) continue;

    const clone = { ...(raw as Record<string, unknown>) };
    if (kept.length > 0) clone.tool_calls = kept;
    else delete clone.tool_calls;
    out.push(clone as T);
  }
  return out;
}
