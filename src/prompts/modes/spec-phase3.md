## Spec 模式 — Phase 3: 验收

任务: {{task}}

上方为规格文档（spec.md），逐项对照验收。

{{currentStep}}
{{progress}}

通过: `workflow({action:"step", id:N, stepAction:"done"})`
不通过: `workflow({action:"step", id:N, stepAction:"blocked", message:"原因"})`

全部通过后自动结束 Spec 模式。
