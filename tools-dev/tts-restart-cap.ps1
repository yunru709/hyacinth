# tts-restart-cap.ps1 — 拉起 CosyVoice 服务并**强制撞顶**，用于验证「撞顶不重试」
#
# 原理：COSYVOICE_MAX_TOKEN_RATIO=2 与上游默认 COSYVOICE_MIN_TOKEN_RATIO=2 相等
#   ⇒ min_len == max_len == 2N ⇒ `ignore_eos=True if i < min_len` 在前 2N 步全程
#     屏蔽 stop token ⇒ 模型一步也停不下来 ⇒ **必然跑满 max_len**（撞顶 100% 复现）。
#
# 判据：若日志出现「撞顶不重试」且 wall 只有单份 max_len 量级（不翻倍）⇒ 改动生效。
$ErrorActionPreference = 'Stop'

$log    = 'C:\Users\74689\.agent\work\tts-server-cap.log'
$py     = 'C:\Python311\python.exe'
$script = 'C:\Users\74689\Desktop\Agent\hyacinth\dist\tts\engines\cosyvoice\server.py'
$model  = 'C:\Users\74689\.agent\models\tts\cosyvoice3'
$voices = 'C:\Users\74689\.agent\models\voices'
$repo   = 'C:\Users\74689\.agent\envs\CosyVoice'

if (Test-Path $log) { Remove-Item $log -Force }

# 注意：set 的值里不能带尾随空格（`&` 前紧贴），否则 PYTHONPATH 末位多一个空格
$cmd = 'cmd /c "set PYTHONPATH=' + $repo + ';' + $repo + '\third_party\Matcha-TTS' + `
       '&set COSYVOICE_MAX_TOKEN_RATIO=2' + `
       '&' + $py + ' ' + $script + ' --model-dir ' + $model + ' --variant rl --port 3178 --voices-dir ' + $voices + `
       ' > ' + $log + ' 2>&1"'

Write-Output "CMD = $cmd"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = 'C:\Users\74689\Desktop\Agent\hyacinth' }
Write-Output "CREATE_RC=$($r.ReturnValue)  PID=$($r.ProcessId)"
