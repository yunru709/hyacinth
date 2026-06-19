# Checklist

- [ ] 初始化失败时不再显示全屏阻塞遮罩，聊天区和面板仍可浏览。
- [ ] 初始化错误以可恢复卡片形式展示，包含重试/设置/查看日志等操作。
- [ ] Header 顶部不再出现原始红色错误横幅。
- [ ] Header 仅保留必要的标题、模式切换、模型芯片、上下文进度条，无重复入口。
- [ ] 点击模型芯片或 ActivityRail "模型" 均打开同一个 Model Center 面板。
- [ ] ActivityRail 图标具备清晰语义，所有按钮均有中文 title/aria-label。
- [ ] Model Center 面板在 300px 宽度下布局不拥挤，表单单栏可阅读。
- [ ] Settings 面板按功能分组，保存行为一致，无冗余保存按钮。
- [ ] Context 面板区分运行时数据与可编辑限制，并有说明文案。
- [ ] Knowledge、Scheduler、ModelCenter、Settings 都有统一的空态、错误态、加载态。
- [ ] 命令面板选择面板类命令可正确打开对应面板，动作类命令可正确执行。
- [ ] 视口小于 1024px 时 InspectorDrawer 以浮层抽屉呈现，Sidebar 可完全折叠。
- [ ] WebUI TypeScript 检查通过。
- [ ] WebUI 生产构建通过。
- [ ] 根项目构建与全局安装验证通过。
