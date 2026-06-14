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
  /**
   * 执行模式：
   * - 'sync'（默认）: 阻塞等待工具完成，结果返回后继续
   * - 'asyncable': 工具支持异步执行（通过 input 中的 async 参数控制），
   *   异步模式下立即返回 handle，不阻塞后续工具和 LLM 轮次
   */
  executionMode?: 'sync' | 'asyncable';
  /**
   * 注入后台进程注册表（仅 asyncable 工具需要）。
   * 由 factory 在组装阶段调用，工具实现方负责类型转换。
   */
  setBackgroundRegistry?(registry: unknown): void;
}
