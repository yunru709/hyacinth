#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音色 A/B —— 同一句话、同一服务，只换参考音，各重复 N 次。

为什么需要它：bench 里「你好，孑遗。」连测三次产出 0.04s / 3.32s / 1.00s，
**同一个输入产出长度差 80 倍** —— 这已经不是速度问题，是合成崩坏。
首要怀疑：参考音与目标文本的语言/长度错配（FlutterShy 是 15.86s 英文长稿）。

本脚本控制变量：文本固定、引擎固定、机器固定，只变 voice。
输出音频长度序列，直接看稳定性。

用法：python -u tts-ab.py --voices FlutterShy,__probe_zh --repeat 4
"""

import argparse
import json
import time
import urllib.error
import urllib.request

URL = 'http://127.0.0.1:3178/tts'
SR = 24000
WAV_HEADER = 44
TEXT = '你好，孑遗。'


def post(text: str, voice: str, speed: float = 1.0, timeout: float = 600.0):
    body = json.dumps({'text': text, 'voice': voice, 'speed': speed}).encode('utf-8')
    req = urllib.request.Request(
        URL, data=body, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST',
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        return {'ok': True, 'wall': time.time() - t, 'audio': max(0, len(data) - WAV_HEADER) / 2 / SR}
    except urllib.error.HTTPError as e:
        return {'ok': False, 'wall': time.time() - t, 'error': f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}'}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'wall': time.time() - t, 'error': f'{type(e).__name__}: {e}'}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voices', default='FlutterShy,__probe_zh')
    ap.add_argument('--repeat', type=int, default=4)
    ap.add_argument('--text', default=TEXT)
    args = ap.parse_args()

    for voice in [v.strip() for v in args.voices.split(',') if v.strip()]:
        print(f'\n=== voice={voice}  text={args.text!r} x{args.repeat} ===', flush=True)
        audios = []
        for i in range(args.repeat):
            r = post(args.text, voice)
            if not r['ok']:
                print(f'  #{i} FAILED {r["wall"]:.2f}s — {r["error"]}', flush=True)
                continue
            audios.append(r['audio'])
            print(f'  #{i} wall={r["wall"]:6.2f}s audio={r["audio"]:6.2f}s', flush=True)
        if audios:
            lo, hi = min(audios), max(audios)
            print(f'  --> audio min={lo:.2f}s max={hi:.2f}s spread={hi - lo:.2f}s  '
                  f'{"STABLE" if hi - lo < 0.35 * max(hi, 0.1) else "UNSTABLE"}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
