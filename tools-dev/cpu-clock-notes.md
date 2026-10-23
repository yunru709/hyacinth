# 为什么任务管理器 CPU「速度」恒为 2.10 GHz（基准频率）

主机：COLORFUL X15 AT 23 / Insyde BIOS 1.07.01TOYC1 / i7-13700HX（P 基频 2.1 / 睿频 5.0；E 基频 1.5 / 睿频 3.7）
系统：Windows 11 Insider Preview 26340；VBS 运行中（`VirtualizationBasedSecurityStatus=2`，`HypervisorPresent=True`）
活动方案：`af77c3cb-cfc8-4516-8e3b-821eb82fd373`（高性能，自定义 GUID）

## 结论（已实测）

1. **不是任务管理器的渲染 bug。** TM 的「速度」取 OS 处理器电源管理（PPM）维护的当前频率，本机该值恒为标称 2100：
   - PDH `\Processor Information(_Total)\Processor Frequency` = 2100（空闲 / 1 线程 / 24 线程三种负载下**完全不动**）
   - `CallNtPowerInformation(ProcessorInformation)`：24/24 逻辑核 **cur = max = limit = 2100**，永远相同
   ⇒ **Windows 的频率模型里这颗 CPU 最高只有基频 2100（没有睿频档位）**，所以它推导的 MHz 永远 ≤ 2100。
   （HAL 注册表 `~MHz` = 2304，BIOS 自己报的数也远低于 5.0 GHz）

2. **CPU 确实高于基频运行**，只是 OS 只能以比值形式看到：`% Processor Performance`（APERF/MPERF 硬件比值）
   实测空闲 **196~216%**、单线程加载 **226%**、per-core 最高 **247%** ⇒ 约 **4.1~5.2 GHz**。
   同一瞬间「MHz 字段 = 2100」与「比值 = 200%+」互相矛盾 —— 这正是"模型缺睿频"的表现。

3. **已推翻的说法（别再引用）**：
   - ~~「min=100% 把 CPU 钉在最大性能、空闲 ~4.4 GHz」~~：MIN 100→5 后空闲 `% Perf` 实测无变化（214→214）；
     再只翻 MIN（5/20 交替四窗口，`cpu-min-ab.log`）四轮全部 `Processor Frequency=2100`、`% Perf` 195.6~203.5
     ⇒ **MIN 不是变量**。`cpu-set-minstate.log` 记录同一结论。
   - ~~「改 MAX=50 能限频」~~：MIN 仍 100 时只改 MAX ⇒ 零变化（min>max 退化配置，**测试无效**）。
   - ~~「平衡方案（min=20）把空闲降到 ~2.0 GHz」~~：`cpu-idle-ab` 里 A(213/216%) vs B(184/188%) 看似可复现，
     但 **B 窗口 CPU 时间只有 7.8~8.3%、A 窗口 12.8~19.2%** ⇒ 与负载共变；且单独翻 MIN 复现不出来 ⇒ 不可归因于方案。
   - **净结论：没找到任何 Windows 侧能把本机空闲频率降下来的杠杆。** 时钟由 OS 之下（固件/EC/HWP）决定
     —— 这与"OS 根本读不到真实值"互为佐证。

4. 两个方案 `powercfg /q` **生效值全量 diff**（各 28 项）只有：`PROCTHROTTLEMIN` 5 vs 20，外加 6 项与处理器无关的
   （显示器/硬盘/睡眠超时）。⇒ 平衡 vs 高性能 的差异**不在处理器设置里**，见 3。

5. 唯一稳的物理比较是**固定 ALU 链吞吐**（`spin.mjs`，8 s/单线程）：两方案 **190.3e6 vs 188.1e6 iters/s（1.011）**
   ⇒ **方案不影响满载性能**，差异只在空闲/上报层。

## 本机改电源配置的硬约束（重要坑）

- `HKLM\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\<plan>\...` 的**属主是 SYSTEM，Administrators 只有 ReadKey**
  ⇒ **直接改注册表连管理员也被拒**（`SecurityException: 不允许所请求的注册表访问权`）——**只有 `powercfg` / Power API 这条代理路径能写**。
- `powercfg /deletesetting <SUB_PROCESSOR> <GUID>`：非提权 rc=1（无权限）；**提权 rc=0 但对未注册的设置项无效**（值仍在）。
- 本 build **没有 `powercfg /setactiveoverlay`**（rc=1，"参数无效"）；三个"电源模式" overlay 在 SUB_PROCESSOR 下**什么都没有**
  ⇒ 别再从 overlay 找答案。`powercfg /L` 只有 平衡 + 高性能 两个方案。

## 遗留：我写进去的一个（大概率惰性的）值，未清除

- 位置：活动方案 `SUB_PROCESSOR\36687f9e-e3a5-4dbf-b1dc-15eb381c6863`(PERFEPP)，`ACSettingIndex=50`
  （我用 `powercfg /setacvalueindex` 写的，当时作为探针；**原始状态是没有这个键**）。
- 证据表明**它不被读取**：`powercfg /q SCHEME_CURRENT SUB_PROCESSOR <该 GUID>` **不列出**它
  （对照：`PROCTHROTTLEMIN` 会列出完整块，含别名/取值范围/AC-DC 值）⇒ PPM 不把它当适用设置。
- 删不掉：raw 注册表写被 ACL 拒（**提权也是**）；`powercfg /deletesetting` 提权 rc=0 但值仍在；
  彻底路径只有 `powercfg /restoredefaultschemes`（会重置/丢自定义方案，未采用）或接管该键属主 + regedit（未采用）。
- 若真要清：regedit 以 SYSTEM/接管属主后删该值，或重建方案。

## 探针（保留在 tools-dev/）

| 文件 | 作用 |
|---|---|
| `why-tm-cpu-speed.ps1` | OS/CPU + VBS + 电源 + NtPowerInformation + 三档负载计数器（第一手证据） |
| `cpu-plan-audit.ps1` | 方案 A/B 对照 + 自动还原 |
| `cpu-idle-ab.ps1` | 交替 A/B 六窗口（含 EPP 组） |
| `cpu-min-ab.ps1` | 只翻 MIN 的四窗口对照（**推翻 MIN**） |
| `cpu-plan-diff.ps1` | 两方案生效值全量 diff（纯 ASCII 解析，规避中文匹配坑） |
| `cpu-set-minstate.ps1` | 改 MIN 并验证（实测无效果） |
| `cpu-epp-rollback.ps1` / `cpu-epp-cleanup.ps1` | 清那个值（均失败，留档说明原因） |
| `spin.mjs` | 固定 ALU 链吞吐探针（**只做同条件相对比较**） |

⚠️ JS 绝对 GHz 不可信：同一段 `sqrt` 链在单循环/三循环两个程序里差 2×（JIT 代码生成差异），
且 V8 Smi 链每轮真实周期数未知（"1 周/轮"假设不成立）。

## 想看真实频率怎么办

- 厂商工具：HWiNFO / CPU-Z（本机没装；火绒会拦新 exe 写 %TEMP%，要用免解包/放非 TEMP 目录）。
- 或 PerfMon 看 `% Processor Performance`：× 2100 ≈ 实际 MHz（本机该计数器噪声 ±15~20%，只看趋势）。

## 追加（2026-10-17 夜）：这是**升级后出现的回归**，不是本机一直如此

孑遗报告「之前 TM 会显示真实频率，现在不显示了」⇒ 查时间线，找到变更点：

| 证据 | 值 |
|---|---|
| `C:\Windows.old\Windows\System32\ntoskrnl.exe` | **10.0.26100.9549**（升级前那套） |
| 当前 `ntoskrnl.exe` | **10.0.26100.9750**（Insider 26340，DisplayVersion 26H2） |
| `C:\Windows.old` 创建时间 | **2026-10-12 03:28:18** ⇒ **就地升级**（非重装） |
| `C:\Windows` 创建时间 | 2026-07-17 ⇒ 原装系统 |
| 今天(10-17) Setup 日志 | KB5127842 / KB5127694 反复 stage→install→uninstall（10:18~16:38，其一"需重启"） |
| 上次启动 / 截图 | 2026-10-17 **20:54:54** / 20:58 |

供数链路的二进制被这次升级整体换版：
`perfproc.dll`、`perfos.dll` 26100.7705 → **26100.8951**；`powrprof.dll` 26100.8117 → **26100.8951**；
`intelppm.sys` 26100.9549 → **26100.9750**；`Taskmgr.exe` 26100.9549 → **26100.8951**。

**TM 的取数源没变**：新旧 `Taskmgr.exe` 都含 `Processor Information` 计数器集名，且**都不引用 `powrprof`**
（`probe` 无命中 ⇒ 不走 `CallNtPowerInformation`）⇒ **变的是喂这个计数器的 OS 层**（PPM/perflib），不是 TM 换写法。

⇒ 现状：该层在这颗 P+E CPU 上只给标称 2100（`CallNtPowerInformation`：24/24 核 cur=max=limit=2100），
所以「速度」永远 2.10 GHz，而 `% Processor Performance`（APERF/MPERF）仍然给出 196~247%（≈4.1~5.2 GHz）。

**唯一能证明"是这次升级造成"的实验 = 回滚**：`C:\Windows.old` 仍在，回滚窗口（升级后 10 天）至 **~10-22**：
设置 → 系统 → 恢复 → 返回上一版本（代价：退回 26100.9549，Insider 会再推）。

未做的低成本补充（等指示）：a) 新旧 perflib/PPM 二进制字符串对照（只证"改了"）；
b) 挂载 `Windows.old` 的 SYSTEM hive 看**升级前的活动电源方案/CPU 设置**（需一次 UAC）—— 用于排除"升级顺手换了电源方案"。
