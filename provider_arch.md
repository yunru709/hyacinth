# 当前 Agent Provider 层架构

> 基于 `src/provider/` 源码阅读整理，2026-06-15

---

## 一、整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                       上层调用者 (Agent Core)                        │
│    LLM / Orchestrator / Skills / Sub-agents / 各种 pipeline         │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  createStream(messages, tools)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ProviderManager (管理入口)                       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                      Provider 实例 (组合)                     │    │
│  │                                                             │    │
│  │  ┌─────────────────────────────────────────────────────┐    │    │
│  │  │            FallbackProviderChain (降级链)             │    │    │
│  │  │  ┌──────────┐  ┌──────────┐          ┌──────────┐  │    │    │
│  │  │  │Resilient │  │Resilient │   ...    │Resilient │  │    │    │
│  │  │  │Provider  │→→│Provider  │→→...→→  │Provider  │  │    │    │
│  │  │  │(primary) │  │(fallback1)│         │(fallbackN)│  │    │    │
│  │  │  └────┬─────┘  └────┬─────┘          └────┬─────┘  │    │    │
│  │  └───────┼─────────────┼─────────────────────┼────────┘    │    │
│  │          │             │                     │             │    │
│  │     ┌────▼─────┐  ┌───▼──────┐         ┌─────▼────┐      │    │
│  │     │Retry + CB│  │Retry + CB│         │Retry + CB│      │    │
│  │     └────┬─────┘  └───┬──────┘         └─────┬────┘      │    │
│  │          │             │                     │             │    │
│  │     ┌────▼─────────────▼─────────────────────▼────────┐    │    │
│  │     │             具体 Provider 实现 (Adapter)          │    │    │
│  │     │                                                   │    │    │
│  │     │  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │    │    │
│  │     │  │Anthropic │  │ OpenAI   │  │ DeepSeek      │  │    │    │
│  │     │  │Provider  │  │Provider  │  │ (兼容OpenAI)   │  │    │    │
│  │     │  ├──────────┤  ├──────────┤  ├───────────────┤  │    │    │
│  │     │  │Gemini    │  │ Local    │  │ Qwen/Zhipu/   │  │    │    │
│  │     │  │Provider  │  │Provider  │  │ MiniMax/MiMo  │  │    │    │
│  │     │  └──────────┘  └──────────┘  │ (兼容Anthropic │  │    │    │
│  │     │                               │  或 OpenAI)   │  │    │    │
│  │     │                               └───────────────┘  │    │    │
│  │     └───────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ModelRouter (子任务路由)           ProviderRouter (注册表路由)      │
│  ┌────────────────────────┐       ┌────────────────────────────┐   │
│  │ assessment → main/local│       │  registry: Map<name, Prov> │   │
│  │ planning  → main/local│       │  route(complexity)         │   │
│  │ compression→ main/local│       │  setDefault(name)         │   │
│  └────────────────────────┘       └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    配置与元数据层                                      │
│                                                                     │
│  ProviderConfigLoader     ProviderMeta (baseUrl, model, envKey)     │
│  LocalConfigLoader        ModelCatalog (ModelInfo, capabilities)    │
│  ConfigManager            项目/全局 config.json                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、各模块职责

### 2.1 接口层 — `interface.ts`

```
Provider (interface)
  ├── createStream(messages, tools?, signal?): AsyncIterable<StreamEvent>
  ├── getProviderType(): ProviderType
  ├── getModel(): string
  ├── getCapabilities?(): ProviderCapabilities  ← toolCalling, streaming, vision, isLocal...
  ├── setThinking?(enabled, effort?)             ← DeepSeek V4 / Anthropic Extended
  ├── loadAdapter?(name, path)                   ← LoRA (仅 local)
  ├── unloadAdapter?(name)
  └── listAdapters?()
```

所有 Provider 实现类都实现这个接口。统一的 `createStream` 入口。

### 2.2 弹性层 — `resilient.ts`

**ResilientProvider**: 装饰器模式，包装任意 Provider，添加：
- **Retry** (重试): 指数退避 (1s→2s→4s→8s, 最多4次)，仅重试可恢复错误 (5xx, 429, 网络错误)
- **Circuit Breaker** (熔断): 连续 5 次失败 → 断路器打开 → 30s 冷却 → 半开试探 → 恢复或再断开
- 已 yield 事件后遇到错误不重试（避免流内容重复）

### 2.3 降级链 — `fallback.ts`

**FallbackProviderChain**: 把多个 Provider 串成链。
- 每个 Provider 独立包裹 ResilientProvider（各自有 retry+CB）
- 按序尝试 [primary, fallback1, fallback2, ...]
- 一个失败自动跳到下一个
- 跨 Provider 时自动清理 `cache_control` 标记（anthropic 独有）
- 回调通知外部切换事件

### 2.4 管理器 — `manager.ts`

**ProviderManager**:
- 入口管理者，构造时创建 Provider 实例
- 自动检测：环境变量 → 自动选择第一个有 API Key 的 provider
- 显式配置：`createProviderFromConfig(config)` 工厂方法
- `switchProvider(config)` 运行时热切换，保留弹性层
- 内置 fallback 链自动发现：主 provider 失败后遍历其他有 key 的 provider

### 2.5 具体 Provider 实现

| Provider | 文件 | 兼容协议 | 特性 |
|----------|------|---------|------|
| AnthropicProvider | `anthropic.ts` | Anthropic API | 原生, tool calling, cache_control |
| OpenAIProvider | `openai.ts` | OpenAI API | 原生, tool calling |
| DeepSeekProvider | `deepseek.ts` | OpenAI 兼容 | thinking/reasoning |
| GeminiProvider | `gemini.ts` | Google API | 原生, 大 context |
| LocalProvider | `local.ts` | OpenAI 兼容 | LoRA adapter, 本地部署 |
| OpenAICompatibleProvider | `compatible.ts` | OpenAI 兼容 | Groq, xAI, Mistral, OpenRouter, Moonshot |
| QwenProvider | `qwen.ts` | Anthropic 兼容 | 阿里系 |
| ZhipuProvider | `zhipu.ts` | OpenAI 兼容 | 智谱 |
| MiniMaxProvider | `minimax.ts` | Anthropic 兼容 | MiniMax |
| MiMoProvider | `mimo.ts` | Anthropic 兼容 | 小米 |

### 2.6 路由层

**ModelRouter** (`model-router.ts`): 双通道路由
- 按角色 (assessment/planning/compression) 路由到 main 或 local provider
- local 失败自动降级到 main

**ProviderRouter** (`router.ts`): 注册表路由（早期遗留，实际不常使用）
- 注册/注销/查询 Provider
- 按复杂度自动路由 (high→在线, low→本地)
- 支持手动覆盖

### 2.7 配置层

**ProviderConfigLoader** (`config.ts`): 从 `.agent/providers.json` 加载元数据
- 内置 14+ Provider 的默认配置 (baseUrl, defaultModel, envKey, maxTokens)
- 首次加载自动生成默认配置文件
- getProvider(id) 快速查找

**LocalConfigLoader** (`local-config.ts`): 本地 Provider 配置

**ModelCatalog** (`catalog.ts`): 模型能力目录（capabilities, cost, context window）

---

## 三、数据流 (一次 LLM 调用)

```
Agent Core
  │ createStream(messages, tools)
  ▼
ProviderManager.getProvider()
  │ ↓ 返回组合好的 Provider 对象
  ▼
FallbackProviderChain.createStream()
  │ 依次尝试链中每个 ResilientProvider
  ▼
ResilientProvider.createStream()
  │ 重试 + 断路器检查
  │ ↓ 成功后
  ▼
AnthropicProvider.createStream()
  │ HTTP 请求 → Anthropic API
  │ ↓ 流式返回
  ▼
StreamEvent (text, tool_call, thinking, error...)
  │ 逐层向上 yield
  ▼
Agent Core 消费事件
```

---

