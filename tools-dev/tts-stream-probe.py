#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 流式探针 —— 验证 inference_zero_shot(stream=True) 的块语义。

要回答三个问题（答案决定 Node/Python 两侧怎么写）：
  1) 每块 samples 是否**恒定**（= 增量块，直接拼即可播放）
     还是**单调递增**（= 累积块，必须自己算 diff，否则叠音）
  2) 首包延迟（第一块多久到达）—— 这是流式的全部意义
  3) 总时长 / 实时率（RTF），与整段模式对照

用法（环境变量由调用方给 PYTHONPATH）：
  python tts-stream-probe.py [--text "..."] [--voice FlutterShy] [--stream 1|0]
"""

import argparse
import os
import sys
import time

REPO = r'C:\Users\74689\.agent\envs\CosyVoice'
MODEL_DIR = r'C:\Users\74689\.agent\models\tts\cosyvoice3'
VOICES = r'C:\Users\74689\.agent\models\voices'

sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'third_party', 'Matcha-TTS'))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--text', default='你好，孑遗。我在测试流式输出，看看首包有多快。')
    ap.add_argument('--voice', default='FlutterShy')
    ap.add_argument('--stream', type=int, default=1)
    args = ap.parse_args()

    from cosyvoice.cli.cosyvoice import CosyVoice3

    fp16 = os.environ.get('COSYVOICE_FP16', '1') != '0'
    t = time.time()
    model = CosyVoice3(MODEL_DIR, load_trt=False, fp16=fp16)
    print(f'[probe] model loaded in {time.time() - t:.2f}s fp16={fp16} sample_rate={model.sample_rate}', flush=True)

    wav = os.path.join(VOICES, args.voice + '.wav')
    txt_path = os.path.join(VOICES, args.voice + '.txt')
    if not (os.path.isfile(wav) and os.path.isfile(txt_path)):
        print(f'[probe] MISSING voice pair: {wav} / {txt_path}', flush=True)
        return 2
    # v3 协议：参考音文字稿必须以 [token] 结尾
    prompt_text = open(txt_path, 'r', encoding='utf-8').read().strip() + '[token]'

    sr = int(model.sample_rate)
    stream = bool(args.stream)
    print(f'[probe] begin stream={stream} text_len={len(args.text)}', flush=True)

    t0 = time.time()
    rows = []          # (idx, samples, t_since_start)
    total = 0
    first_at = None
    for i, out in enumerate(model.inference_zero_shot(args.text, prompt_text, wav, stream=stream, speed=1.0)):
        sp = out['tts_speech']
        n = int(sp.shape[-1])
        dt = time.time() - t0
        if first_at is None:
            first_at = dt
        total += n
        rows.append((i, n, dt))
        print(f'[probe] chunk={i:<3} samples={n:<6} dur={n / sr:6.3f}s at={dt:7.3f}s cum_samples={total}', flush=True)

    wall = time.time() - t0
    print('---', flush=True)
    print(f'[probe] chunks={len(rows)} total_samples={total} audio={total / sr:.3f}s wall={wall:.3f}s', flush=True)
    print(f'[probe] first_chunk_at={first_at if first_at is not None else -1:.3f}s', flush=True)
    if total:
        print(f'[probe] RTF={wall / (total / sr):.3f}x (越小越好；<1 = 快于实时)', flush=True)

    if len(rows) >= 2:
        sizes = [r[1] for r in rows]
        constant = len(set(sizes)) == 1
        increasing = all(sizes[i] > sizes[i - 1] for i in range(1, len(sizes)))
        print(f'[probe] VERDICT constant_size={constant} monotonically_increasing={increasing}', flush=True)
        print(f'[probe] sizes={sizes[:24]}{" ..." if len(sizes) > 24 else ""}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
