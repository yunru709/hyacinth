<#
  desktop-build.ps1 —— 构建 / 部署 / 启动 hyacinth 桌面壳（.NET 10 + WinForms + WebView2）

  2026-10-16 起随源码进仓库：此前只有"手敲 dotnet publish"这条路，源码目录里没有任何
  可执行入口（用户实报「源码目录下没有类似 exe 的启动方式」）。

  做三件事：
    1. dotnet publish（Release / win-x64 / 框架依赖）→ desktop/native-shell/out
    2. 部署到 %LOCALAPPDATA%\Programs\hyacinth-shell（exe 的固定落点，快捷方式指向它）
    3. 建/刷新桌面快捷方式 Hyacinth.lnk

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/desktop-build.ps1              # 全做
    powershell -ExecutionPolicy Bypass -File scripts/desktop-build.ps1 -SkipBuild   # 只部署
    powershell -ExecutionPolicy Bypass -File scripts/desktop-build.ps1 -Launch      # 做完后启动
    powershell -ExecutionPolicy Bypass -File scripts/desktop-build.ps1 -NoShortcut  # 不动快捷方式

  走仓库根的 npm 脚本更省事：pnpm run desktop:build / pnpm run desktop
#>
param(
  [switch]$SkipBuild,
  [switch]$NoShortcut,
  [switch]$Launch,
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $repo 'desktop\native-shell\native-shell.csproj'
$outDir = Join-Path $repo 'desktop\native-shell\out'
$deployDir = Join-Path $env:LOCALAPPDATA 'Programs\hyacinth-shell'
$deployExe = Join-Path $deployDir 'native-shell.exe'

if (-not (Test-Path $proj)) { throw "找不到桌面壳工程: $proj" }

# 后端要存在：壳拉起的是 dist/index.js webui（缺了会白屏 + 后端立刻退出）
if (-not (Test-Path (Join-Path $repo 'dist\index.js'))) {
  Write-Host '[!] 还没构建过后端（dist/index.js 不存在）⇒ 先跑一次 pnpm run build' -ForegroundColor Yellow
}

if ($SkipBuild) {
  if (-not (Test-Path $deployExe)) { throw "没有已部署的 exe（$deployExe）⇒ 先跑一次不带 -SkipBuild 的构建" }
  Write-Host '[1/3] 跳过构建（-SkipBuild）' -ForegroundColor DarkGray
} else {
  Write-Host '[1/3] dotnet publish ...' -ForegroundColor Cyan
  if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '找不到 dotnet（需要 .NET SDK 10）' }
  # --self-contained false = 框架依赖：exe 仅 ~158KB，但运行机需装 .NET 10 运行时
  & dotnet publish $proj -c $Configuration -r win-x64 --self-contained false -o $outDir
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（退出码 $LASTEXITCODE）" }
}

Write-Host "[2/3] 部署到 $deployDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $deployDir | Out-Null
Get-ChildItem $outDir -File | Copy-Item -Destination $deployDir -Force
Get-ChildItem $outDir -Directory | Copy-Item -Destination $deployDir -Recurse -Force
if (-not (Test-Path $deployExe)) { throw "部署后仍找不到 $deployExe" }

if ($NoShortcut) {
  Write-Host '[3/3] 跳过快捷方式（-NoShortcut）' -ForegroundColor DarkGray
} else {
  Write-Host '[3/3] 建/刷新桌面快捷方式 Hyacinth.lnk ...' -ForegroundColor Cyan
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hyacinth.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $deployExe
  $sc.WorkingDirectory = $deployDir
  $sc.IconLocation = $deployExe
  $sc.Description = 'Hyacinth'
  $sc.Save()
}

$kb = [Math]::Round((Get-Item $deployExe).Length / 1KB, 1)
Write-Host "完成 ✓  exe = $deployExe  ($kb KB)" -ForegroundColor Green

if ($Launch) {
  Write-Host '启动桌面壳 ...' -ForegroundColor Cyan
  # 用 WMI Create：父进程是 WMI ⇒ 壳不会随本脚本/终端退出被清理
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ('"' + $deployExe + '"'); CurrentDirectory = $deployDir
  } | Out-Null
}
