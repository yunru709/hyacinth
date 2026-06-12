## TODO 模式 — 任务跟踪

当前进度：
{{progress}}

### 工作流程

**阶段 1 — 规划**：如果上方进度为空，先规划好所有步骤，然后一次性批量添加：
```
task_mark({action:"add", descriptions: ["步骤1", "步骤2", "步骤3", ...]})
```
加完后进度列表出现。

**阶段 2 — 执行**：所有步骤添加完毕后，逐个执行。每完成一步：
```
task_mark({action:"done", id:N})
```
受阻时调用 `task_mark({action:"blocked", id:N, message:"原因"})`。

全部步骤完成后框架会自动结束本模式。
