#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""稳定性归因实验：跨语言 / 文本-参考音长度失配 是不是抖动来源。

假设 H：抖动来自「参考音=15.86s 英文长稿，待合成=短中文」的失配，
        而非模型采样本身。
判据：同语言（英文）合成应显著比跨语言（中文）稳定。
若 H 成立 ⇒ 修法不是调 ratio，而是换/裁参考音（即孑遗的 ② 音色注册）。

对照组设计（同一服务、同一音色、交替跑避免漂移）：
  EN-SHORT  "Okay."                                （同语言，短）
  EN-MID    "Now I'm testing the speech output."   （同语言，中）
  ZH-SHORT  "你好，孑遗。"                            （跨语言，短）
  ZH-MID    "现在我在测试流式输出，看看首包到底有多快。"   （跨语言，中）
每组 repeat 次，交替轮转。指标：audio 时长 min/max/spread、失败数。
"""
import json, sys, time, urllib.request, urllib.error

URL = 'http://127.0.0.1:3178/tts'
SR = 24000
WAV_HDR = 44
VOICE = 'FlutterShy'
REPEAT = 4

CASES = [
    ('EN-SHORT', 'Okay.'),
    ('EN-MID', "Now I am testing the speech output."),
    ('ZH-SHORT', '你好，孑遗。'),
    ('ZH-MID', '现在我在测试流式输出，看看首包到底有多快。'),
]

def synth(text):
    body = json.dumps({'text': text, 'voice': VOICE}).encode('utf-8')
    req = urllib.request.Request(URL, data=body, headers={'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        dur = (len(data) - WAV_HDR) / (SR * 2)
        return ('ok', round(time.time() - t0, 2), round(dur, 2), '')
    except urllib.error.HTTPError as e:
        return ('err', round(time.time() - t0, 2), 0.0, e.read().decode('utf-8', 'replace')[:100])
    except Exception as e:
        return ('err', round(time.time() - t0, 2), 0.0, f'{type(e).__name__}: {e}')

def main():
    results = {k: [] for k, _ in CASES}
    for rnd in range(REPEAT):
        for name, text in CASES:
            st, wall, dur, msg = synth(text)
            results[name].append((st, wall, dur, msg))
            print(f'  r{rnd} {name:9s} {st:3s} wall={wall:6.2f}s audio={dur:5.2f}s {msg}', flush=True)

    print()
    print('=== SUMMARY ===')
    print(f'{"case":10s} {"ok":>4s} {"audio_min":>10s} {"audio_max":>10s} {"spread":>8s} {"cv":>7s}')
    for name, _ in CASES:
        rows = results[name]
        oks = [d for st, _, d, _ in rows if st == 'ok']
        n_err = sum(1 for st, _, _, _ in rows if st == 'err')
        if oks:
            mn, mx = min(oks), max(oks)
            mean = sum(oks) / len(oks)
            spread = mx - mn
            cv = (spread / mean) if mean else 0.0
            print(f'{name:10s} {len(oks):>3d}/{len(rows)} {mn:>9.2f}s {mx:>9.2f}s {spread:>7.2f}s {cv:>6.2f}  err={n_err}')
        else:
            print(f'{name:10s} 0/{len(rows)}  ALL FAILED (err={n_err})')

if __name__ == '__main__':
    main()
