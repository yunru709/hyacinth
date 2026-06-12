## Spec 模式 — Phase 2: 执行任务

任务: {{task}}

上方为规格文档（spec.md），以此为准则逐项执行。

{{currentStep}}
{{progress}}

每完成一项: `mode_mark({action:"done", id:N})`
受阻: `mode_mark({action:"blocked", id:N, message:"原因"})`

全部完成后自动进入验收阶段。
