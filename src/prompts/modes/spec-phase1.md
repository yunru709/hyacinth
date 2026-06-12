## Spec 模式 — Phase 1: 编写规格文档

任务: {{task}}
文件目录: {{specDir}}

### ⚠️ 必须使用 mode_mark 工具

创建文件**必须**用 `mode_mark`，不要用 `write` 替代。

**一步创建三个文件**：
```
mode_mark({action:"init", spec: "spec.md全文", tasks: "tasks.md全文", checklist: "checklist.md全文"})
```
tasks 和 checklist 中每行一个条目，格式 `- [ ] 描述文字`。

**完成后推进到 Phase 2**：
```
mode_mark({action:"done", id:0})
```

`write` 仅用于编辑已创建的文件内容（如补充 spec.md 细节）。
