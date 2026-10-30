<#
  desktop-package.ps1 —— 打一个「绿色版」桌面包：一个文件夹，双击 exe 就能跑

  形态对齐用户给的样本（F:\DSH —— Electron 装完就是"主 exe + 一堆支撑文件"的文件夹）：
  不依赖源码树、不依赖 pnpm、也不要求目标机装 .NET / Node。

  ⚠️ **为什么不默认用"单文件打包"**（2026-10-16 本机实测，两种错都踩了）：
    本机**火绒**（HipsDaemon / wsctrlsvc）会限制**加壳 exe** 往 `%TEMP%` 写东西，表现为两次秒退：
      ① 压缩单文件：`Failed to create default extraction directory [...\Temp\.net]. error code: 5`
         （5 = 拒绝访问 ⇒ 连自解包目录都建不出来）
      ② 不压缩单文件：`System.UnauthorizedAccessException: Access to the path
         '...\Temp\ffyju0n0.4vp' is denied` —— 崩在
         `Application.EnableVisualStyles()`（WinForms 要往 temp 落一个清单文件）
    而未加壳的普通 exe（`desktop-build.ps1` 部署的那个）在同机一直正常 ⇒ **问题在"壳"**，
    不在我们的代码。默认改为**自包含但不打包**：托管程序集与原生库都以普通文件平铺在目录里，
    没有任何自解包/加壳行为，也就不触发那类拦截。
    （真要用单文件就加 `-Packed`，但那在本机需要给火绒放行。）

  产出（默认 <repo>\desktop\dist\Hyacinth\）：
    Hyacinth.exe            主程序（自包含 ⇒ 目标机无需装 .NET）
    *.dll / runtimes\       .NET 运行时与 WebView2 原生库（**别删**，exe 靠它们跑）
    runtime\node.exe        自带 Node（约 86 MB）⇒ 目标机无需装 Node
    app\dist\               后端编译产物（含 prompts / webui / grammars）
    app\node_modules\       依赖（当前为全量拷贝；要更小可后续裁成 --prod）
    app\plugins\            随仓库分发的目录插件（companion 等）
    app\package.json
    README.txt              怎么用
    logs\                   首次运行生成

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/desktop-package.ps1
    powershell -ExecutionPolicy Bypass -File scripts/desktop-package.ps1 -OutDir C:\Hyacinth
    powershell -ExecutionPolicy Bypass -File scripts/desktop-package.ps1 -SkipDeps   # 只更新壳 + dist
#>
param(
  [string]$OutDir = '',
  [switch]$SkipDeps,
  [switch]$Packed,
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $repo 'desktop\native-shell\native-shell.csproj'
$pubDir = Join-Path $repo 'desktop\native-shell\pub-out'
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $repo 'desktop\dist\Hyacinth' }

# ── 前置检查 ────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $repo 'dist\index.js'))) {
  throw '后端还没构建（缺 dist\index.js）⇒ 先在仓库里跑 pnpm run build'
}
if (-not (Test-Path $proj)) { throw "找不到桌面壳工程: $proj" }

$nodeExe = $null
foreach ($c in @("$env:ProgramFiles\nodejs\node.exe")) {
  if (Test-Path $c) { $nodeExe = $c; break }
}
if (-not $nodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe) { throw '找不到 node.exe（绿色包要自带一份）' }

Write-Host "输出目录 : $OutDir" -ForegroundColor Cyan
Write-Host "自带 node: $nodeExe" -ForegroundColor Cyan
Write-Host "打包模式 : $(if ($Packed) { '单文件（加壳，本机可能被火绒拦）' } else { '自包含不打包（默认，稳）' })" -ForegroundColor Cyan
Write-Host ''

# ── 1/4 壳 ──────────────────────────────────────────────────────────
Write-Host '[1/4] dotnet publish ...' -ForegroundColor Cyan
if (Test-Path $pubDir) { Remove-Item $pubDir -Recurse -Force }
if ($Packed) {
  & dotnet publish $proj -c $Configuration -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=false `
    -p:IncludeNativeLibrariesForSelfExtract=false -o $pubDir
} else {
  # 自包含（带 .NET 运行时）+ **不打包**：目录里是普通文件，没有任何自解包行为
  & dotnet publish $proj -c $Configuration -r win-x64 --self-contained true -o $pubDir
}
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（退出码 $LASTEXITCODE）" }

$pubExe = Join-Path $pubDir 'native-shell.exe'
if (-not (Test-Path $pubExe)) { throw "publish 后找不到 exe（$pubExe）" }

# ── 2/4 组装：把 publish 目录整体搬进来（exe 改名为 Hyacinth.exe）──────
Write-Host '[2/4] 组装目录（壳 + 它的运行时 dll）...' -ForegroundColor Cyan
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'runtime') | Out-Null

Get-ChildItem $pubDir | Where-Object { $_.Name -ne 'native-shell.exe' } |
  ForEach-Object { Copy-Item $_.FullName -Destination $OutDir -Recurse -Force }
Copy-Item $pubExe (Join-Path $OutDir 'Hyacinth.exe') -Force
Copy-Item $nodeExe (Join-Path $OutDir 'runtime\node.exe') -Force
$shellFiles = @(Get-ChildItem $OutDir -Recurse -File).Count
Write-Host "      壳目录文件数（含运行时 dll）= $shellFiles" -ForegroundColor DarkGray

# ── 3/4 应用负载 ────────────────────────────────────────────────────
Write-Host '[3/4] 复制后端负载（dist / plugins / package.json / node_modules）...' -ForegroundColor Cyan
$appDir = Join-Path $OutDir 'app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item (Join-Path $repo 'dist') (Join-Path $appDir 'dist') -Recurse -Force
Copy-Item (Join-Path $repo 'package.json') $appDir -Force
if (Test-Path (Join-Path $repo 'plugins')) {
  $pluginsDest = Join-Path $appDir 'plugins'
  if (Test-Path $pluginsDest) { Remove-Item $pluginsDest -Recurse -Force }
  Copy-Item (Join-Path $repo 'plugins') $pluginsDest -Recurse -Force
}

$depsDest = Join-Path $appDir 'node_modules'
if ($SkipDeps) {
  throw '-SkipDeps 不再支持：组装阶段会清空输出目录 ⇒ 依赖必须一起复制（用完整模式重跑）'
} else {
  # 用 robocopy 而不是 Copy-Item：数万个小文件，Copy-Item 会慢到离谱
  $null = robocopy (Join-Path $repo 'node_modules') $depsDest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
  if ($LASTEXITCODE -ge 8) { throw "robocopy 复制 node_modules 失败（退出码 $LASTEXITCODE）" }
}

# ── 4/4 说明文件 + 体积 ─────────────────────────────────────────────
$readme = @'
Hyacinth 桌面版（绿色包）
=========================

怎么用
------
双击 Hyacinth.exe。

首次启动会在本目录生成 logs\；用户数据（配置 / 会话 / 记忆）在 %USERPROFILE%\.agent\，
与本包无关，删掉本目录不会丢数据。

包里有什么
----------
Hyacinth.exe        主程序（自包含 ⇒ 不需要装 .NET）
*.dll / runtimes\   .NET 运行时与 WebView2 原生库 —— **别删**，exe 靠它们运行
runtime\node.exe    自带 Node（约 86MB）⇒ 不需要装 Node
app\                后端：dist（编译产物）+ node_modules + plugins + package.json
logs\               后端与壳的日志（排障先看这里）

整包可以整个拷到别的机器 / 盘符，路径不写死（壳以**自己所在目录**为基准找 node 与 app\）。

依赖
----
* 系统需有 **WebView2 运行时**（Win10/11 一般自带；没有就装 Microsoft Edge WebView2 Runtime）。
* 端口默认 3130，可用 HYACINTH_PORT 覆盖。
* 可用环境变量：HYACINTH_PROVIDER（默认 deepseek）、HYACINTH_PORT、
  HYACINTH_WEBVIEW2_DEBUG_PORT（默认 9222，设 0 关掉）。

注意
----
后端以 `--no-auth` 启动（仅监听本机回环）—— 桌面自用形态；要对外提供请自行加鉴权。
'@
Set-Content -Path (Join-Path $OutDir 'README.txt') -Value $readme -Encoding UTF8

$total = (Get-ChildItem $OutDir -Recurse -File | Measure-Object Length -Sum).Sum
$exeMB = [Math]::Round((Get-Item (Join-Path $OutDir 'Hyacinth.exe')).Length / 1MB, 1)
Write-Host ''
Write-Host "[4/4] 完成 ✓" -ForegroundColor Green
Write-Host ("  Hyacinth.exe = {0} MB" -f $exeMB)
Write-Host ("  整包       = {0} MB" -f [Math]::Round($total / 1MB, 1))
Write-Host ("  位置       = {0}" -f $OutDir)
