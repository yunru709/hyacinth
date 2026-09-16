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
