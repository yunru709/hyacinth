# Tasks

- [x] Task 1: 重构 WebUI 控制台布局
  - [x] SubTask 1.1: 新增 Activity Rail 状态与视图切换模型
  - [x] SubTask 1.2: 将现有 Sidebar 拆为 Sessions panel，并接入 Activity Rail
  - [x] SubTask 1.3: 新增右侧 Inspector/Drawer 容器
  - [x] SubTask 1.4: 调整 Header，使模型、模式、上下文、连接状态成为可点击入口

- [x] Task 2: 实现 Settings 与 Context 面板
  - [x] SubTask 2.1: 新增 Context panel，展示 tokens、maxTokens、cacheHitRate、compressCount
  - [x] SubTask 2.2: 新增 Settings panel，包含 Safety、Compression、Repair、Logging 分组
  - [x] SubTask 2.3: 后端 WebUI API 支持 `PATCH /api/config` 的安全配置更新
  - [x] SubTask 2.4: 前端保存设置后刷新配置状态并显示成功/失败反馈

- [x] Task 3: 实现 Model Center 面板骨架与当前状态接入
  - [x] SubTask 3.1: 新增 Model Center panel，展示当前 provider/model/routing 状态
  - [x] SubTask 3.2: 展示 online provider/model 选择区的 UI 骨架
  - [x] SubTask 3.3: 展示 local model 状态区的 UI 骨架
  - [x] SubTask 3.4: 展示 thinking 设置与 model channel routing UI 骨架
  - [x] SubTask 3.5: 后端补充最小 `/api/model-status` 或复用 `/api/status` 返回 Model Center 所需数据

- [x] Task 4: 实现 Knowledge 与 Scheduler 面板
  - [x] SubTask 4.1: 新增 Knowledge panel，展示 KB stats、Zone4/KB 状态占位和搜索框
  - [x] SubTask 4.2: 接入 `/api/kb/query` 与 `/api/kb/stats`
  - [x] SubTask 4.3: 新增 Scheduler panel，展示任务列表空态和新增任务表单骨架
  - [x] SubTask 4.4: 若后端 scheduler API 尚不可用，则用明确的 unavailable 状态提示

- [x] Task 5: 改造聊天输入、权限和命令入口
  - [x] SubTask 5.1: InputArea 在 processing 时不再完全禁用，展示 Queue、Insert、Stop 操作
  - [x] SubTask 5.2: 增加队列 UI 状态与协议预留，不强制完成后端队列消费
  - [x] SubTask 5.3: 将 Permission bar 改为更明显的 modal/bottom sheet，并保留 Y/A/N 快捷键
  - [x] SubTask 5.4: 新增 Command Palette UI，加载命令列表或使用本地占位数据

- [x] Task 6: 验证与回归
  - [x] SubTask 6.1: 运行根项目 TypeScript 检查
  - [x] SubTask 6.2: 运行 WebUI TypeScript 检查
  - [x] SubTask 6.3: 验证 WebUI 主要路径：连接、会话切换、模式切换、设置打开、模型面板、知识库搜索、权限响应

# Task Dependencies
- Task 2 depends on Task 1 because panels need the new layout containers.
- Task 3 depends on Task 1 and can run in parallel with Task 2 after layout is ready.
- Task 4 depends on Task 1 and can run in parallel with Task 2 and Task 3.
- Task 5 depends on Task 1 but can be partially implemented in parallel with Task 2-4.
- Task 6 depends on Tasks 1-5.
