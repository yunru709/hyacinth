/**
 * Tool 接口定义
 * 所有内置工具和自定义工具都必须实现此接口
 */
export interface Tool {
  /** 工具名称，全局唯一标识 */
  name: string;
  /** 工具描述，供 LLM 理解工具用途 */
  description: string;
  /** 输入参数的 JSON Schema 定义 */
  inputSchema: Record<string, unknown>;
  /** 执行工具，返回结果文本。signal 可用于中断长时间运行的工具 */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
