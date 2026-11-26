; Hyacinth 安装器（Inno Setup 6）
;
; 把绿色包 staging 目录打成 setup.exe：
;   - 装到 {localappdata}\Programs\Hyacinth（无需管理员）
;   - 桌面 / 开始菜单快捷方式 + 卸载器
;   - 启动项指向 native-shell.exe（壳自己拉起 runtime\node.exe + app\dist）
;
; 编译：
;   ISCC.exe /DStageDir="<green-zip-staging>" installer\hyacinth.iss
;
; 注意：staging 必须已由 scripts/package-portable.ps1 生成（含 native-shell.exe / runtime / app）。

#define MyAppName "Hyacinth"
#define MyAppVersion "1.0.2"
#define MyAppExeName "native-shell.exe"
#ifndef StageDir
  #define StageDir "C:\Users\74689\AppData\Local\Temp\hyacinth-portable-1.0.2-win-x64"
#endif

[Setup]
AppId={{5F1C3D2A-8B4E-4F6A-9C7D-1E2B3A4C5D6E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={localappdata}\Programs\Hyacinth
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=Hyacinth-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\desktop\native-shell\app.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
