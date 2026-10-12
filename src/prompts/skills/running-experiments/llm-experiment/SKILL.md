---
name: llm-experiment
description: >-
  面向 LLM / 人工智能训练与评测的实验规范，是 running-experiments 主技能的领域子技能，通常由主技能
  在 Step 2 之前路由进入。补充预训练与微调实验设计、训练不稳定与 loss spike 处置、超参搜索预算、
  数据配比析因、评估基准与评估集饱和、推理非确定性、量化精度、对齐与安全评估。当实验对象是模型训练、
  微调、超参搜索、数据配比、评估基准或对齐安全时使用。
  Domain-specific experiment rules for LLM / AI model training and evaluation.
---

# 子技能 · LLM / 人工智能实验规范

> **上游**：本文件从属于主技能 `../SKILL.md`。**通用规范（原则、生命周期、统计、报告、数据卫生、算力预算、追踪）一律以 SKILL.md 及其 `../reference/` 为准**，本文件只补充 LLM 领域**专属**内容。
> **交接契约**：切换时机为 **Step 2 之前**（见 `../SKILL.md` 第 5 节）。进入前须已冻结实验登记表，并把 `../SKILL.md` 第 5 节所列冻结项原文传入（问题、H1、H_alt、指标 M、基线 b 与 δ、MDE、支持/否定/不确定判据、IV、DV、CV、混淆处置、种子集合、停止规则、预算盒）。本文件**不得改写上述任何项**。
> 通用反模式见 `../reference/anti-patterns.md`；跨域实验应先加载本文件，再加载 `../agent-experiment/SKILL.md`。

## 1. LLM 专属变量

| 类别 | 示例 |
| --- | --- |
| IV 自变量 | 模型规模与架构、学习率与调度、数据配比、上下文长度、解码参数、微调方式（全参 / LoRA） |
| DV 因变量 | 训练 / 验证 loss 与 perplexity、下游任务准确率、pass@k、生成质量评分、显存与吞吐 |
| CV 控制变量 | 随机种子、数据顺序、tokenizer、batch 结构、精度（bf16/fp32）、硬件 |
| 混淆变量 | 数据顺序、dropout、并行非确定性、kernel 差异、断点续训 |

## 2. 训练 / 微调实验
- 记录完整 **loss 曲线**与验证曲线，关注过拟合拐点，而非只看最终点。
- **训练不稳定 / loss spike**：定义 spike 判定（绝对阈值或相对跳变）；诊断（问题数据批、LR、数值溢出 / NaN）；处置（skip batch、回滚 checkpoint、降 LR / 加 warmup）。**必须申报是否发生及处理方式**，禁止只报最终 loss。
- checkpoint 选择规则必须**预先声明**（按验证集），**不得用测试集选 checkpoint**（见 `../reference/reproducibility.md` 第 4 节）。
- 数据配比实验属**析因**问题，注意交互作用（`../reference/methods.md` 第 3 节）。

## 3. 超参搜索预算
- 与基线**等预算**（`../reference/methods.md` 第 1 节）；写清搜索空间、trials 数、选择策略（随机 / Bayesian / successive halving）。
- 嵌套划分；测试集不参与搜索（`../reference/reproducibility.md` 第 4 节）。
- 搜索本身算作一次实验，需登记；报告 best-trial 的**选择偏差**。

## 4. 数据（仅 LLM 专属增量）
- 通用划分 / 防泄漏 / 去重见 `../reference/reproducibility.md` 第 4 节，本节不重复。
- LLM 增量：去污染须给出**量化口径**（n-gram 重叠阈值、同源模板检测），并报告去污染前后的重评差值。

## 5. 评估
- 指标按任务选定：perplexity、准确率、F1、pass@k、BLEU/ROUGE 等，须写明计算口径。
- **评估集饱和**：检测 ceiling（对照人类 / oracle 上限）；准确率报 Wilson 或 Clopper-Pearson CI；pass@k 报估计方差与所需样本量；饱和时须给出替换 / 升级协议。
- **LLM-as-judge**：报告 judge 模型与版本、prompt、位置偏差（交换顺序复测）、与人工标注的一致性（Cohen κ / Krippendorff α + 抽样量 + CI）；judge 不是真值。
- 生成任务须固定解码参数与重复次数，报方差。

## 6. 随机性与非确定性
- 来源：初始化、数据顺序、dropout、采样、kernel 非确定性。
- 默认 **≥5 个种子**（见 `../reference/methods.md` 第 5 节）；训练成本高时用 pilot 估方差再定种子数（第 6 节）。
- 推理可复现步骤：固定种子 + 确定性 kernel + batch 不变性 + 确定性解码；申报是否逐位可复现与 prompt 格式敏感性。

## 7. 版本锁定（防漂移）
- tokenizer 版本与 vocab；数据快照哈希与许可证；**eval harness 版本与 prompt 模板**。

## 8. 量化与精度实验
- bf16 / fp8 / int8 对指标与吞吐的影响，作为 IV 登记。

## 9. 算力与预算
- 预算表：GPU 时、显存峰值、吞吐（tokens/s）、费用；对接 `../reference/reproducibility.md` 第 5 节。
- 小规模代理实验（proxy）可先筛方案，但**必须验证**代理结论能否迁移到目标规模。

## 10. 对齐与安全评估
- 除能力指标外，须评估安全维度（有害输出率、越狱率、拒答率）与其代价（过度拒答），并给出 red-teaming 协议（攻击样本集、样本量、有害率 CI）。
- 对齐改动常带来**能力回退**：必须同时报能力与安全指标，做权衡表；微调的灾难性遗忘同样双测。

## 11. 专属陷阱
- 用测试集选 checkpoint / 调超参（泄漏）。
- 只报最终 loss，掩盖训练不稳定。
- 评估集饱和导致「改进」是假象。
- judge 偏差未校准。
- 代理实验结果被当作目标规模结论。

## 12. 报告要点
- 结果表遵循 `../reference/reporting.md` 第 5 节；生成类任务报均值 ± 方差。
- 必报：能力与安全的权衡、算力成本、复现所需超参全量。