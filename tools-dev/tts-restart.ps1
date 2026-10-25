# tts-restart.ps1 — 手动拉起 CosyVoice 推理服务（带主进程同款 PYTHONPATH）
# 2026-10-25：为验证 server.py 的「撞顶不重试」改动。日志重定向到文件便于核验。
$ErrorActionPreference = 'Stop'

$log     = 'C:\Users\74689\.agent\work\tts-server.log'
$py      = 'C:\Python311\python.exe'
$script  = 'C:\Users\74689\Desktop\Agent\hyacinth\dist\tts\engines\cosyvoice\server.py'
$model   = 'C:\Users\74689\.agent\models\tts\cosyvoice3'
$voices  = 'C:\Users\74689\.agent\models\voices'
$repo    = 'C:\Users\74689\.agent\envs\CosyVoice'

if (Test-Path $log) { Remove-Item $log -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

$cmd = 'cmd /c "set PYTHONPATH=' + $repo + ';' + $repo + '\third_party\Matcha-TTS&' + `
       $py + ' ' + $script + ' --model-dir ' + $model + ' --variant rl --port 3178 --voices-dir ' + $voices + `
       ' > ' + $log + ' 2>&1"'

Write-Output "CMD = $cmd"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = 'C:\Users\74689\Desktop\Agent\hyacinth' }
Write-Output "CREATE_RC=$($r.ReturnValue)  PID=$($r.ProcessId)"
