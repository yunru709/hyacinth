# Tasks

- [ ] Task 1: 迁移 hot-reload watcher 路径到 homedir — 修改所有 watcher 将用户级路径从 cwd 改为 homedir
  - [ ] SubTask 1.1: bundle-watcher.ts — tool-bundles.json 路径改为 os.homedir()
  - [ ] SubTask 1.2: tool-watcher.ts — tools 目录路径改为 os.homedir()
  - [ ] SubTask 1.3: plugin-watcher.ts — plugins 目录路径改为 os.homedir()
  - [ ] SubTask 1.4: agent-watcher.ts — 移除项目级 mkdirSync，保留双路径监听
  - [ ] SubTask 1.5: skill-watcher.ts — 移除项目级 mkdirSync，保留双路径监听
  - [ ] SubTask 1.6: prompt-watcher.ts — 外部 prompts 路径改为 os.homedir()
  - [ ] SubTask 1.7: provider-watcher.ts — providers.json 路径改为 os.homedir()
  - [ ] SubTask 1.8: model-catalog-watcher.ts — models-catalog.json 路径改为 os.homedir()
  - [ ] SubTask 1.9: mcp-watcher.ts — 添加 ~/.agent/mcp.json 为主监听路径
  - [ ] SubTask 1.10: manifest-loader.ts — 移除 generateDefaults 中的 mkdirSync
  - [ ] SubTask 1.11: config-watcher.ts — 移除项目级 mkdirSync（仅监听，不创建）
  - [ ] SubTask 1.12: channel-watcher.ts — 移除项目级 mkdirSync（仅监听，不创建）

- [ ] Task 2: 迁移 restart 标记文件路径到 homedir
  - [ ] SubTask 2.1: tools/restart.ts — 标记文件路径改为 os.homedir()
  - [ ] SubTask 2.2: gateway/tui.ts — /restart 和 /new 命令路径改为 os.homedir()
  - [ ] SubTask 2.3: gateway/cli.ts — 标记文件路径改为 os.homedir()
  - [ ] SubTask 2.4: gateway/server.ts — 配置监听路径改为 os.homedir()

- [ ] Task 3: 迁移 rollback 目录到 homedir
  - [ ] SubTask 3.1: gateway/factory.ts — rollbackDir 改为 os.homedir()

- [ ] Task 4: 编译验证与全局安装
  - [ ] SubTask 4.1: 后端 pnpm build
  - [ ] SubTask 4.2: pnpm link --global

# Task Dependencies
- Task 2, Task 3 与 Task 1 无依赖，可并行
- Task 4 依赖 Task 1-3 全部完成