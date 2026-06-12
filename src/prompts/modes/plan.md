## Plan 模式 — 分步执行

任务: {{task}}

### 当前进度
{{currentStep}}
{{progress}}

### ⚠️ 必须使用 mode_mark 工具

创建文件和标记步骤**必须**使用 `mode_mark`，不要用 `write` 替代。
`write` 工具仅用于：修改已经创建好的 plan.md 中的步骤描述。

**第一步 — 创建 plan.md**：
```
mode_mark({action:"init", content: "你的plan完整内容"})
```
文件中每行一个步骤，格式 `- [ ] 描述文字`（只有这种格式才能被解析）。

**执行中 — 标记完成**：
```
mode_mark({action:"done", id:N})
```

**受阻 — 标记受阻**：
```
mode_mark({action:"blocked", id:N, message:"原因"})
```
