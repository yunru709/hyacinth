# Tasks
- [x] Task 1: 修复 WebUI session 创建与切换
  - [x] SubTask 1.1: 后端 `POST /api/sessions` 支持 `type` 参数并固定写入 `channel: webui`
  - [x] SubTask 1.2: 前端新建 session 时提供 normal/precise 选择
  - [x] SubTask 1.3: 新建成功后自动清空当前视图并切换 WebSocket session
  - [x] SubTask 1.4: Sidebar 将未知 session 分类为 Legacy/Unknown，而不是 TUI

- [x] Task 2: 对齐 WebUI precise 模式与 TUI 行为
  - [x] SubTask 2.1: 后端 WebSocket 支持 session-aware 的 normal/precise 模式切换
  - [x] SubTask 2.2: WebUI Header 提供 Normal/Precise 可视化切换入口
  - [x] SubTask 2.3: 模式切换后更新当前 session 与 UI 状态

- [x] Task 3: 增加 WebUI 常用命令的可视化入口
  - [x] SubTask 3.1: ChatLog 增加清屏按钮
  - [x] SubTask 3.2: ChatLog 增加全部工具卡片折叠/展开按钮
  - [x] SubTask 3.3: ChatLog 增加帮助面板或帮助消息按钮

- [x] Task 4: 验证与类型检查
  - [x] SubTask 4.1: 运行根项目 TypeScript 检查
  - [x] SubTask 4.2: 运行 WebUI TypeScript 检查
  - [x] SubTask 4.3: 检查 session 创建、切换、分类和模式切换的用户路径

# Task Dependencies
- Task 2 depends on Task 1 because precise mode switching requires reliable WebUI session creation and switching.
- Task 3 can be implemented in parallel with Task 1 after shared store actions are identified.
- Task 4 depends on Tasks 1-3.
