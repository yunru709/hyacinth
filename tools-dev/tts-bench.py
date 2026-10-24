#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 /tts 基线测速 —— 直接打已在跑的 3178 服务。

测什么：
  1) 首句 vs 后续句的耗时差 ⇒ 量化「参考音 speech_feat/speech_token 每次重算」
     这块固定开销（frontend_zero_shot 每次都对 prompt.wav 做一遍特征提取）
  2) 文本长度 → 耗时曲线 ⇒ 估算 RTF，判断瓶颈在 prompt 开销还是生成长度
  3) 401 之类错误的真实文本（字面量，不用编造）

用法：python -u tts-bench.py [--voice FlutterShy]
"""

import argparse
import json
import time
import urllib.request

URL = 'http://127.0.0.1:3178/tts'
SR = 24000
WAV_HEADER = 44


def post(text: str, voice: str, speed: float = 1.0, timeout: float = 600.0):
    body = json.dumps({'text': text, 'voice': voice, 'speed': speed}).encode('utf-8')
    req = urllib.request.Request(
        URL, data=body, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST',
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        dt = time.time() - t
        audio = max(0, len(data) - WAV_HEADER) / 2 / SR
        return {'ok': True, 'wall': dt, 'bytes': len(data), 'audio': audio}
    except urllib.error.HTTPError as e:
        return {'ok': False, 'wall': time.time() - t, 'error': f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:300]}'}
    except Exception as e:  # noqa: BLE001 — 探针要如实报出任何失败
        return {'ok': False, 'wall': time.time() - t, 'error': f'{type(e).__name__}: {e}'}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default='FlutterShy')
    args = ap.parse_args()

    cases = [
        ('warmup', '你好。'),
        ('same-1', '你好，孑遗。'),
        ('same-2', '你好，孑遗。'),
        ('same-3', '你好，孑遗。'),
        ('mid', '现在我在测试流式输出，看看首包到底有多快。'),
        ('long', '清晨的光从木屋窗子斜进来，落在摊开的记事本上。我听见院子里有小动物窸窸窣窣地走动，而你大概正琢磨着那个配置值该填什么。'),
    ]

    print(f'voice={args.voice} url={URL}', flush=True)
    for tag, text in cases:
        r = post(text, args.voice)
        if not r['ok']:
            print(f'{tag:<8} len={len(text):<3} FAILED in {r["wall"]:.2f}s — {r["error"]}', flush=True)
            continue
        rtf = r['wall'] / r['audio'] if r['audio'] else 0
        print(
            f'{tag:<8} len={len(text):<3} wall={r["wall"]:6.2f}s audio={r["audio"]:6.2f}s '
            f'RTF={rtf:5.2f}x bytes={r["bytes"]}',
            flush=True,
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
