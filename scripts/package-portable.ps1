<#
  package-portable.ps1 —— 打一个「绿色包」zip（双击 native-shell.exe 即用）

  产物结构（与 desktop/native-shell/MainForm.cs 的 BundledAppRoot / ResolveNode 对应）：
    hyacinth-portable-<ver>-win-x64/
      native-shell.exe        self-contained 桌面壳（含 .NET 运行时，换机无需装 .NET）
      runtime/node.exe        Node 24（换机无需装 Node）
      app/
        dist/                 后端构建产物（含 prompts/webui/plugins/grammars）
        node_modules/         生产依赖（hoisted 扁平结构，无符号链接）
        package.json
      logs/                   运行时生成
      启动.bat                双击入口
      README.txt

  为什么不是 Electron / NSIS：
    - 本项目是「C# WinForms + WebView2 壳 + Node 后端」，不是 Electron；
      MainForm.cs 已内置「绿色包 / 开发形态」双形态检测，绿色包是它原生支持的部署方式。
    - NSIS 安装器（setup.exe）可作为下一步在这份 zip 之上再加；本脚本先产出可直接运行的绿色包。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1
    powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1 -SkipBuild
#>
param(
  [string]$OutDir = 'release',
  [switch]$SkipBuild,
  [switch]$SkipPublish,
  [string]$NodeExe = 'F:\Node\node.exe'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$ver = $pkg.version
$name = "hyacinth-portable-$ver-win-x64"
$stage = Join-Path $env:TEMP $name
$zip = Join-Path $repo "$OutDir\$name.zip"

Write-Host "[0/7] 版本 $ver，staging = $stage" -ForegroundColor Cyan

# 前置：后端必须已构建
if (-not (Test-Path (Join-Path $repo 'dist\index.js'))) {
  throw 'dist\index.js 不存在 ⇒ 先跑 pnpm run build（或去掉 -SkipBuild）'
}
if (-not (Test-Path $NodeExe)) {
  throw "找不到 node.exe: $NodeExe（用 -NodeExe 指定）"
}

# 清理旧 staging
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$appDir = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# ── 1. 后端构建（可跳过）──────────────────────────────────────────────
if ($SkipBuild) {
  Write-Host '[1/7] 跳过后端构建（-SkipBuild）' -ForegroundColor DarkGray
} else {
  Write-Host '[1/7] pnpm run build ...' -ForegroundColor Cyan
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw "pnpm run build 失败（$LASTEXITCODE）" }
}

# ── 2. dotnet publish（self-contained）────────────────────────────────
Write-Host '[2/7] dotnet publish（self-contained，含 .NET 运行时）...' -ForegroundColor Cyan
$proj = Join-Path $repo 'desktop\native-shell\native-shell.csproj'
if ($SkipPublish) {
  Write-Host '      跳过 publish（-SkipPublish），从 desktop\native-shell\out 复用' -ForegroundColor DarkGray
  $publishSrc = Join-Path $repo 'desktop\native-shell\out'
  if (-not (Test-Path $publishSrc)) { throw '没有可复用的 out 目录' }
} else {
  & dotnet publish $proj -c Release -r win-x64 --self-contained true -o $stage
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（$LASTEXITCODE）" }
  $publishSrc = $stage
}

# ── 3. Node 运行时 ────────────────────────────────────────────────────
Write-Host '[3/7] 复制 node.exe → runtime\' -ForegroundColor Cyan
$runtimeDir = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item $NodeExe (Join-Path $runtimeDir 'node.exe') -Force

# ── 4. 后端 app（dist + package.json）─────────────────────────────────
Write-Host '[4/7] 复制 dist → app\dist' -ForegroundColor Cyan
Copy-Item (Join-Path $repo 'dist') (Join-Path $appDir 'dist') -Recurse -Force
Copy-Item (Join-Path $repo 'package.json') (Join-Path $appDir 'package.json') -Force

# ── 5. 生产依赖（hoisted，避免 pnpm 符号链接离开本机失效）─────────────
Write-Host '[5/7] 安装生产依赖（hoisted）...' -ForegroundColor Cyan
if (Test-Path (Join-Path $repo 'pnpm-lock.yaml')) {
  Copy-Item (Join-Path $repo 'pnpm-lock.yaml') (Join-Path $appDir 'pnpm-lock.yaml') -Force
}
Push-Location $appDir
try {
  pnpm install --prod --frozen-lockfile --node-linker=hoisted
  if ($LASTEXITCODE -ne 0) { throw "pnpm install --prod 失败（$LASTEXITCODE）" }
} finally {
  Pop-Location
}

# ── 6. 启动器 + 说明 ─────────────────────────────────────────────────
Write-Host '[6/7] 写启动.bat / README.txt' -ForegroundColor Cyan
$bat = @'
@echo off
rem Hyacinth 绿色包启动器：直接拉起桌面壳（壳会自己启动 Node 后端）
start "" "%~dp0native-shell.exe"
'@
Set-Content -Path (Join-Path $stage '启动.bat') -Value $bat -Encoding ASCII

$readme = @'
Hyacinth 绿色包（Windows x64）

双击「启动.bat」或「native-shell.exe」即可运行。
- 无需安装 Node / .NET / pnpm：node.exe 在 runtime\，.NET 运行时随壳自带。
- 首次启动会在 %LOCALAPPDATA%\Hyacinth 下生成用户数据（会话、配置等）。
- 日志在 logs\ 目录。

卸载：直接删除本文件夹即可（用户数据在 %LOCALAPPDATA%\Hyacinth，可另行清理）。
'@
Set-Content -Path (Join-Path $stage 'README.txt') -Value $readme -Encoding UTF8

# ── 7. 打 zip ────────────────────────────────────────────────────────
Write-Host '[7/7] Compress-Archive ...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $repo $OutDir) | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
if ($LASTEXITCODE -ne 0) { throw "Compress-Archive 失败（$LASTEXITCODE）" }

$size = (Get-Item $zip).Length / 1MB
Write-Host ("完成 ✓  {0}  ({1:N1} MB)" -f $zip, $size) -ForegroundColor Green
