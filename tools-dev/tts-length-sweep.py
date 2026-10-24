#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 文本长度 → 合成成功率 扫描。

背景（2026-10-25 实测）：同一音色下
  · 6 字「你好，孑遗。」 ×4 → 2.04s / 500 / 0.08s / 2.00s   （崩）
  · 21 字「现在我在测试流式输出…」 → 5.68s                    （正常）
两个音色（15.86s 英文长稿 FlutterShy、官方中文 __probe_zh）崩法一致
⇒ 怀疑与「音色」无关，与「文本太短、LLM 过早输出 EOS」有关。
本脚本做长度扫描，判定拐点在哪。

判定口径（先写死，避免事后凑结论）：
  ok   = HTTP 200 且 audio >= 0.3s
  bad  = HTTP 200 但 audio < 0.3s（模型秒停）
  err  = HTTP 500 等异常
某长度 3 次里 >=2 次 ok 记为该长度「可用」。

用法：python -u tts-length-sweep.py [--voice FlutterShy] [--repeat 3]
"""

import argparse
import json
import time
import urllib.error
import urllib.request

URL = 'http://127.0.0.1:3178/tts'
SR = 24000
WAV_HEADER = 44
OK_MIN_AUDIO = 0.3

CASES = [
    ('3字', '你好。'),
    ('6字', '你好，孑遗。'),
    ('10字', '你好孑遗，我在测试语音。'),
    ('15字', '你好孑遗，我现在在测试语音合成的稳定性。'),
    ('21字', '现在我在测试流式输出，看看首包到底有多快。'),
    ('31字', '清晨的光从木屋窗子斜进来，落在摊开的记事本上，我听见院子里有小动物在走动。'),
]


def post(text: str, voice: str, timeout: float = 300.0):
    body = json.dumps({'text': text, 'voice': voice, 'speed': 1.0}).encode('utf-8')
    req = urllib.request.Request(
        URL, data=body, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST',
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        audio = max(0, len(data) - WAV_HEADER) / 2 / SR
        return {'kind': 'ok' if audio >= OK_MIN_AUDIO else 'bad', 'wall': time.time() - t, 'audio': audio}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace').strip()
        return {'kind': 'err', 'wall': time.time() - t, 'error': f'HTTP {e.code}: {detail[:120]}'}
    except Exception as e:  # noqa: BLE001
        return {'kind': 'err', 'wall': time.time() - t, 'error': f'{type(e).__name__}: {e}'}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default='FlutterShy')
    ap.add_argument('--repeat', type=int, default=3)
    args = ap.parse_args()

    print(f'voice={args.voice} repeat={args.repeat} ok_min_audio={OK_MIN_AUDIO}s', flush=True)
    verdicts = []
    for tag, text in CASES:
        kinds = []
        audios = []
        walls = []
        for _ in range(args.repeat):
            r = post(text, args.voice)
            kinds.append(r['kind'])
            walls.append(r['wall'])
            if r['kind'] == 'err':
                print(f'  {tag} len={len(text):<3} ERR {r["wall"]:5.2f}s {r["error"]}', flush=True)
            else:
                audios.append(r['audio'])
                print(f'  {tag} len={len(text):<3} {r["kind"]:<3} wall={r["wall"]:5.2f}s audio={r["audio"]:5.2f}s', flush=True)
        ok_n = kinds.count('ok')
        usable = ok_n >= max(2, (args.repeat + 1) // 2)
        verdicts.append((tag, len(text), ok_n, args.repeat, usable,
                         f'{min(audios):.2f}~{max(audios):.2f}s' if audios else '-'))
        print(f'  --> {tag}: ok {ok_n}/{args.repeat} → {"USABLE" if usable else "BROKEN"}\n', flush=True)

    print('=== SUMMARY ===', flush=True)
    print(f'{"len":>5} {"ok":>6} {"usable":>7}  audio_range', flush=True)
    for tag, n, ok_n, rep, usable, rng in verdicts:
        print(f'{n:>5} {f"{ok_n}/{rep}":>6} {str(usable):>7}  {rng}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
