# Fix Config Path to Homedir Spec

## Why
用户从桌面启动 TUI 时，`process.cwd()` = `C:\Users\74689\Desktop`，导致 7+ 处代码在桌面创建 `.agent` 目录，12 个 watcher 监听桌面路径触发 EPERM 错误。系统应将用户级运行时数据（tools、plugins、bundles、rollback、restart flags 等）存储在 `~/.agent/` 下。

## What Changes
- 所有用户级运行时数据路径从 `cwd/.agent/` 改为 `os.homedir()/.agent/`
- 用户级 watcher 监听路径从 `cwd/.agent/` 改为 `os.homedir()/.agent/`
- 项目级配置/技能/agent/manifest 的 watcher 保留 `cwd` 路径，但移除启动时的无条件 mkdirSync
- **BREAKING**: `restart` 工具的重启标记文件路径从 `cwd/.agent/` 改为 `~/.agent/`

## Impact
- Affected specs: 无
- Affected code: 15+ 个文件

## ADDED Requirements

### Requirement: User-Level Path Separation
系统 SHALL 将所有用户级运行时数据（工具热加载、插件热加载、Bundle 热加载、Provider 配置、Model Catalog、回滚存储、重启标记文件、MCP 配置、外部 Prompts）存储在 `os.homedir()/.agent/` 下，而非 `cwd/.agent/`。

#### Scenario: 从桌面启动 TUI
- **WHEN** 用户在桌面目录执行 `deepthink`
- **THEN** 不在桌面创建 `.agent` 目录
- **AND** 所有 watcher 监听 `~/.agent/` 下的路径

#### Scenario: 从项目目录启动 TUI
- **WHEN** 用户在项目目录执行 `deepthink`
- **THEN** 不在 `cwd/.agent/` 下创建用户级目录
- **AND** 项目级配置（skills 子目录等）按需创建（非启动时强制）

### Requirement: Watcher Path Migration
所有热加载 watcher SHALL 优先监听 `os.homedir()/.agent/` 下的用户级配置，项目级路径作为补充（不创建目录）。

#### Scenario: Tool watcher 启动
- **WHEN** HotReloadManager 启动 tool watcher
- **THEN** 监听 `~/.agent/tools/` 而非 `cwd/.agent/tools/`
- **AND** 启动时创建 `~/.agent/tools/`（若不存在）

### Requirement: Restart Flag File Migration
`restart` 工具和 TUI/CLI 中的 `/restart`、`/new` 命令 SHALL 将标记文件写入 `~/.agent/` 而非 `cwd/.agent/`。

#### Scenario: Agent 调用 restart 工具
- **WHEN** Agent 执行 restart 工具
- **THEN** 在 `~/.agent/.restart-session` 写入标记文件
- **AND** 不在 `cwd/.agent/` 创建任何目录

## MODIFIED Requirements
无。

## REMOVED Requirements
无。