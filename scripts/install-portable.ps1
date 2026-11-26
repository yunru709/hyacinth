<#
  install-portable.ps1 —— 绿色包安装器（不依赖 %TEMP% 解包）

  为什么不用 Inno Setup 的 setup.exe：
    火绒（HipsDaemon）对「新编译的未签名 exe」有系统加固规则，
    setup.exe 启动时要写 %TEMP%\is-*.tmp 被静默拒绝（Error 5），
    而 PowerShell 是系统可信程序，不受此限制。

  做的事与 setup.exe 等价：
    1. 解压 zip 到 %LOCALAPPDATA%\Programs\Hyacinth
    2. 建开始菜单 + 桌面快捷方式
    3. 写 HKCU 卸载注册表项（设置→应用 可卸载）
    4. 生成卸载脚本 uninstall.ps1

  用法：
    双击同目录的「安装.cmd」
    或 powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1
#>
param(
  [string]$ZipPath = '',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Hyacinth'),
  [switch]$NoDesktopIcon
)

$ErrorActionPreference = 'Stop'

# 找 zip：默认用 release 目录下最新的 hyacinth-portable-*.zip
if (-not $ZipPath) {
  $releaseDir = Join-Path $PSScriptRoot '..\release'
  $zip = Get-ChildItem (Join-Path $releaseDir 'hyacinth-portable-*.zip') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $zip) { throw "找不到安装包：$releaseDir\hyacinth-portable-*.zip" }
  $ZipPath = $zip.FullName
} elseif (-not (Test-Path $ZipPath)) {
  throw "找不到安装包：$ZipPath"
}

Write-Host "安装包：$ZipPath"
Write-Host "安装到：$InstallDir"

# 1. 解压（先解到临时同级目录，成功后再替换，避免半成品）
$staging = "$InstallDir.__new"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Write-Host '解压中（约 1-3 分钟）...'
Expand-Archive -Path $ZipPath -DestinationPath $staging -Force
$exe = Join-Path $staging 'native-shell.exe'
if (-not (Test-Path $exe)) { throw "解压后找不到 native-shell.exe（zip 结构不对）" }

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Move-Item $staging $InstallDir
$exe = Join-Path $InstallDir 'native-shell.exe'

# 2. 生成卸载脚本
$uninstall = @'
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $PSCommandPath
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hyacinth'
Remove-Item $key -Recurse -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Hyacinth.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Hyacinth') -Recurse -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hyacinth.lnk') -Force
# 自删除：延迟后由 cmd 删除本目录
Start-Process cmd -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q ""$dir""" -WindowStyle Hidden
'@
Set-Content -Path (Join-Path $InstallDir 'uninstall.ps1') -Value $uninstall -Encoding UTF8

# 3. 快捷方式
$ws = New-Object -ComObject WScript.Shell
$startMenuDir = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
$lnk = $ws.CreateShortcut((Join-Path $startMenuDir 'Hyacinth.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $InstallDir
$lnk.IconLocation = $exe
$lnk.Description = 'Hyacinth'
$lnk.Save()

if (-not $NoDesktopIcon) {
  $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hyacinth.lnk'
  $dlnk = $ws.CreateShortcut($desk)
  $dlnk.TargetPath = $exe
  $dlnk.WorkingDirectory = $InstallDir
  $dlnk.IconLocation = $exe
  $dlnk.Description = 'Hyacinth'
  $dlnk.Save()
}

# 4. 卸载注册表项（HKCU，无需管理员）
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hyacinth'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty $key -Name DisplayName -Value 'Hyacinth'
Set-ItemProperty $key -Name DisplayVersion -Value '1.0.2'
Set-ItemProperty $key -Name Publisher -Value 'Hyacinth'
Set-ItemProperty $key -Name InstallLocation -Value $InstallDir
Set-ItemProperty $key -Name DisplayIcon -Value $exe
Set-ItemProperty $key -Name UninstallString -Value "powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Set-ItemProperty $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty $key -Name NoRepair -Value 1 -Type DWord
Set-ItemProperty $key -Name EstimatedSize -Value ([int]((Get-ChildItem $InstallDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)) -Type DWord

Write-Host ''
Write-Host "安装完成 ✓  $InstallDir" -ForegroundColor Green
Write-Host '开始菜单「Hyacinth」已创建；桌面快捷方式已创建；设置→应用 里可卸载。'
Write-Host '启动方式：双击安装目录下的 native-shell.exe，或开始菜单快捷方式。'
