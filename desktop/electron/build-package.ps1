# ============================================================
# 组装 DSH 样式自包含 Electron 包
# ============================================================
# 布局（对齐 F:\DSH\）：
#   <Out>\
#     Hyacinth.exe             electron.exe 改名
#     *.dll / *.pak / *.bin / *.dat / locales\   Chromium 支撑件
#     version                  44.7.2
#     resources\
#       app.asar               壳（main.js / preload.js / package.json）
#       app.asar.unpacked\     （空壳，保留结构）
#       app\                    hyacinth 后端：dist / plugins / node_modules / package.json
#       runtime\node.exe        自带真 node（Electron 只当窗口宿主）
#       icon.png
#
# 关键决策（为什么自带 node.exe）：
#   `ELECTRON_RUN_AS_NODE=1 electron.exe dist/index.js webui --port N` 实测被 commander
#   拒为 `unknown option '--port'`（真 node 同一命令正常）⇒ 后端改用包内 runtime\node.exe。
#   Electron 只负责窗口，不承担后端运行时 —— 两侧解耦，互不牵连。
param(
  [string]$Out   = 'F:\Hyacinth-Electron',
  [string]$Stage = 'C:\Users\74689\Desktop\Agent\hyacinth-electron\stage',
  [string]$Shell = 'C:\Users\74689\Desktop\Agent\hyacinth-desktop',
  [string]$ElecDist = 'C:\Users\74689\Desktop\Agent\hyacinth-desktop\node_modules\electron\dist',
  [string]$NodeExe  = 'F:\Node\node.exe'
)

$ErrorActionPreference = 'Stop'
function Log($m) { Write-Host "[build] $m" }

# ── 0. 清理 ───────────────────────────────────────────────
if (Test-Path $Out) {
  Log "清空已存在的 $Out"
  Remove-Item $Out -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# ── 1. Electron 运行时（Chromium 支撑件）────────────────────
Log "复制 Electron 运行时 -> $Out"
# 只复制 dist 顶层文件（不含 resources\ 里的 default_app.asar，我们自建）
Get-ChildItem $ElecDist -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $Out $_.Name) -Force
}
# locales
Copy-Item (Join-Path $ElecDist 'locales') (Join-Path $Out 'locales') -Recurse -Force
Log "  electron.exe -> 将改名为 Hyacinth.exe"

# ── 2. version 文件 ───────────────────────────────────────
$ver = (Get-Content (Join-Path $ElecDist 'version') -Raw).Trim()
$ver | Out-File (Join-Path $Out 'version') -Encoding ascii -NoNewline
Log "  version = $ver"

# ── 3. exe 改名 ───────────────────────────────────────────
Rename-Item (Join-Path $Out 'electron.exe') 'Hyacinth.exe'
Log "  Hyacinth.exe 就位（$([math]::Round((Get-Item (Join-Path $Out 'Hyacinth.exe')).Length/1MB,1)) MB）"

# ── 4. resources\ ─────────────────────────────────────────
$res = Join-Path $Out 'resources'
New-Item -ItemType Directory -Force -Path $res | Out-Null

# 4a. 后端 app（物化好的依赖树）
Log "复制后端 app（node_modules 280 包，约 314MB，慢）..."
$appDst = Join-Path $res 'app'
New-Item -ItemType Directory -Force -Path $appDst | Out-Null
foreach ($d in 'dist','plugins','node_modules') {
  $src = Join-Path $Stage "app\$d"
  if (-not (Test-Path $src)) { throw "缺少 $src —— 先跑 materialize.mjs" }
  Copy-Item $src (Join-Path $appDst $d) -Recurse -Force
  Log "  + $d"
}
Copy-Item (Join-Path $Stage 'app\package.json') (Join-Path $appDst 'package.json') -Force
Log "  + package.json"

# 4b. 自带 node 运行时
Log "复制 node 运行时..."
$rt = Join-Path $res 'runtime'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
Copy-Item $NodeExe (Join-Path $rt 'node.exe') -Force
Log "  + runtime\node.exe（$([math]::Round((Get-Item (Join-Path $rt 'node.exe')).Length/1MB,1)) MB）"

# ── 5. 壳代码 → app.asar ──────────────────────────────────
# 用 Electron 自带的 asar 模块打包（@electron/asar 可能没装，直接用 electron 的 asar）
Log "打包壳 -> app.asar"
$shellStage = Join-Path $Stage 'shell'
if (Test-Path $shellStage) { Remove-Item $shellStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $shellStage | Out-Null
Copy-Item (Join-Path $Shell 'main.js')    (Join-Path $shellStage 'main.js')    -Force
Copy-Item (Join-Path $Shell 'preload.js') (Join-Path $shellStage 'preload.js') -Force
Copy-Item (Join-Path $Shell 'package.json') (Join-Path $shellStage 'package.json') -Force
# 覆盖 package.json：去掉 devDependencies（asar 里不需要 electron 包本身）
# ⚠️ PS 5.1 的 Get-Content -Raw 默认按 GBK 解码 ⇒ 含中文/emoji 的 JSON 会变乱码
#    并被 ConvertFrom-Json 拒收（报 'Invalid object passed in'）⇒ 必须显式 UTF-8。
$pkgTxt = [System.IO.File]::ReadAllText((Join-Path $shellStage 'package.json'), [System.Text.Encoding]::UTF8)
$pkg = $pkgTxt | ConvertFrom-Json
$pkg.PSObject.Properties.Remove('devDependencies')
$pkg.PSObject.Properties.Remove('pnpm')
$pkg.main = 'main.js'
$pkgJson = $pkg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path $shellStage 'package.json'), $pkgJson, (New-Object System.Text.UTF8Encoding($false)))

$asar = Join-Path $res 'app.asar'

# @electron/asar 4.x 的 package.json **没有 main 字段**（只有 exports: ./lib/asar.js）
# ⇒ `require('asar')` 会 MODULE_NOT_FOUND ⇒ 必须用绝对路径指向 lib/asar.js。
$asarLib = Join-Path $Shell 'node_modules\@electron\asar\lib\asar.js'

if (Test-Path $asarLib) {
  Log "  用 @electron/asar: $asarLib"
  $asarJs = Join-Path $Stage 'make-asar.cjs'
  $js = "const asar = require(" + ($asarLib | ConvertTo-Json) + ");`n" +
        "asar.createPackage(process.argv[2], process.argv[3]).then(() => console.log('asar ok')).catch(e => { console.error(e); process.exit(1); });`n"
  [System.IO.File]::WriteAllText($asarJs, $js, (New-Object System.Text.UTF8Encoding($false)))
  & $NodeExe $asarJs $shellStage $asar
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $asar)) { throw 'asar 打包失败' }
} else {
  throw "未找到 @electron/asar: $asarLib"
}
Log "  app.asar = $([math]::Round((Get-Item $asar).Length/1KB,1)) KB"

# 保留 app.asar.unpacked 结构（DSH 样式）
New-Item -ItemType Directory -Force -Path (Join-Path $res 'app.asar.unpacked') | Out-Null

# ── 6. 图标 ───────────────────────────────────────────────
$iconSrc = 'F:\DSH\resources\icon.png'
if (Test-Path $iconSrc) {
  Copy-Item $iconSrc (Join-Path $res 'icon.png') -Force
  Log "  + resources\icon.png"
}

# ── 7. 汇总 ───────────────────────────────────────────────
Log "========== 完成 =========="
$tot = (Get-ChildItem $Out -Recurse -File -Force | Measure-Object Length -Sum)
Log "总大小 = $([math]::Round($tot.Sum/1MB,1)) MB / $($tot.Count) 文件"
Log "顶层:"
Get-ChildItem $Out -Force | Select-Object Mode, Length, Name | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
