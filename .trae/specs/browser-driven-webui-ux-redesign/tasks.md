# Tasks

- [x] Task 1: 重新设计初始化与错误状态
  - [x] SubTask 1.1: 用非阻塞状态指示器替换全屏 "初始化 Agent..." 遮罩
  - [x] SubTask 1.2: 新增 InitializationErrorCard 组件，展示友好错误说明与重试/设置/查看日志按钮
  - [x] SubTask 1.3: 移除 Header 顶部原始红色错误横幅，改在聊天区顶部显示可恢复提示
  - [x] SubTask 1.4: 初始化失败时仍允许用户浏览会话列表面板和设置面板

- [x] Task 2: 简化 Header 信息架构并移除重复入口
  - [x] SubTask 2.1: Header 仅保留 DeepThink 标题、模式切换、模型状态芯片、上下文进度条
  - [x] SubTask 2.2: 点击模型芯片统一打开 Model Center 面板
  - [x] SubTask 2.3: 移除 Header 中单独的状态/模式详情 inspector 按钮，或将其合并到对应面板
  - [x] SubTask 2.4: 上下文进度条点击后打开 Context 面板

- [x] Task 3: 改进 ActivityRail 图标与可识别性
  - [x] SubTask 3.1: 将抽象符号替换为更易识别的图标或文字标签
  - [x] SubTask 3.2: 确保所有 rail 按钮都有中文 title 与 aria-label
  - [x] SubTask 3.3: 统一 active/hover/disabled 状态样式

- [ ] Task 4: 优化 InspectorDrawer 面板布局
  - [ ] SubTask 4.1: ModelCenterPanel 重构为单栏表单布局，避免 300px 内多列拥挤
  - [ ] SubTask 4.2: SettingsPanel 按功能分组为可折叠/标签页，统一保存行为
  - [ ] SubTask 4.3: ContextPanel 区分只读运行时数据与可编辑限制，并添加说明文案
  - [ ] SubTask 4.4: 统一所有卡片的间距、标题、按钮大小与空态样式

- [ ] Task 5: 统一空态、加载态与错误态
  - [ ] SubTask 5.1: 为 Knowledge、Scheduler、ModelCenter、Settings 设计统一 EmptyState 组件
  - [ ] SubTask 5.2: 为各面板 API 加载失败提供 ErrorState 组件（带重试按钮）
  - [ ] SubTask 5.3: 加载中使用统一 LoadingSkeleton 或 spinner，避免多面板样式不一致

- [ ] Task 6: 完善命令面板映射与交互
  - [ ] SubTask 6.1: 在 CommandPalette 中维护命令 id 到 ActivityView/PanelView/Action 的映射
  - [ ] SubTask 6.2: 后端 /api/commands 返回的命令经映射后可正确打开面板或执行动作
  - [ ] SubTask 6.3: 命令面板支持键盘上下选择与 Enter 执行

- [ ] Task 7: 响应式与可访问性兜底
  - [ ] SubTask 7.1: 在视口宽度小于 1024px 时 InspectorDrawer 以抽屉浮层形式呈现
  - [ ] SubTask 7.2: Sidebar 在窄视口下可完全折叠，聊天区占满剩余空间
  - [ ] SubTask 7.3: 检查所有交互元素的最小点击区域与颜色对比度

- [ ] Task 8: 验证与回归
  - [ ] SubTask 8.1: WebUI TypeScript 检查通过
  - [ ] SubTask 8.2: WebUI 生产构建通过
  - [ ] SubTask 8.3: 在浏览器中验证初始化错误态、各面板打开、命令面板、响应式折叠
  - [ ] SubTask 8.4: 根项目构建与全局安装验证

# Task Dependencies
- Task 2 depends on Task 1 because Header simplification relies on the new initialization/error state not needing a top banner.
- Task 4 depends on Task 2 because panel layout changes depend on which controls remain in the Header.
- Task 5 can run in parallel with Task 4 after EmptyState/ErrorState components are designed.
- Task 6 depends on Task 2 because CommandPalette mappings reference the final panel routing.
- Task 7 depends on Task 2 and Task 4 because responsive behavior involves Header, Sidebar, and Drawer.
- Task 8 depends on Tasks 1-7.
