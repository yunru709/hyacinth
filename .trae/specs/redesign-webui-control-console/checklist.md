# Checklist

- [x] WebUI 存在 Activity Rail，并能切换 Sessions、Models、Knowledge、Scheduler、Settings 等视图。
- [x] Sessions 面板保留现有创建、删除、切换、分组能力。
- [x] Header 中的模型、模式、上下文、连接状态具备清晰可见的控制台入口或状态展示。
- [x] Context 面板显示 tokens、maxTokens、cacheHitRate、compressCount。
- [x] Settings 面板包含 Safety、Compression、Repair、Logging 分组。
- [x] 后端支持安全的 WebUI 配置更新接口，且不会暴露敏感配置。
- [x] Model Center 显示当前 provider/model，并提供 online/local/thinking/channel 的可视化区域。
- [x] Knowledge 面板可以调用 KB stats 与 query API，并显示结果或空态。
- [x] Scheduler 面板至少提供任务列表空态和新增任务表单骨架。
- [x] Processing 时 InputArea 不再只靠禁用输入表达状态，能展示 Queue/Insert/Stop 操作。
- [x] 权限请求以 modal 或 bottom sheet 形式呈现，并保留 Yes/Always/No 快捷键。
- [x] Command Palette UI 可打开，并展示可执行操作列表或命令占位。
- [x] 根项目 TypeScript 检查通过。
- [x] WebUI TypeScript 检查通过。
