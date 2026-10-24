#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 流式探针 v2 —— 直接复用 server.py 的加载路径。

v1 失败原因：自己 new CosyVoice3(model_dir) 会找 `llm.pt`，而本机只下了
`llm.rl.pt`（rl variant）。server.py 里已有「rl-only 时把 llm.rl.pt 硬链成
llm.pt、构造完再删链」的处理，还有 wetext 离线 patch —— 复用它，保证探针
跑的路径与真实服务**完全一致**（否则探的就不是生产环境）。

要回答：
  1) 每块 samples 是**增量**（直接拼可播）还是**累积**（须自己 diff）
  2) 首包延迟 / 块大小分布 / 总 RTF
  3) stream=True 下 speed 是否真的生效

用法：python -u tts-stream-probe.py --variant rl --voice FlutterShy --stream 1
"""

import argparse
import importlib.util
import io
import os
import sys
import time

REPO = r'C:\Users\74689\.agent\envs\CosyVoice'
MODEL_DIR = r'C:\Users\74689\.agent\models\tts\cosyvoice3'
VOICES = r'C:\Users\74689\.agent\models\voices'
SERVER_PY = r'C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py'

sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'third_party', 'Matcha-TTS'))


def load_server_module():
    """把 server.py 当模块载入（它有 __main__ 保护，不会跑 main）。"""
    spec = importlib.util.spec_from_file_location('cvserver', SERVER_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--text', default='你好，孑遗。我在测试流式输出，看看首包有多快。')
    ap.add_argument('--voice', default='FlutterShy')
    ap.add_argument('--variant', default='rl', choices=['base', 'rl'])
    ap.add_argument('--stream', type=int, default=1)
    ap.add_argument('--speed', type=float, default=1.0)
    args = ap.parse_args()

    srv = load_server_module()
    srv._ARGS = argparse.Namespace(
        model_dir=MODEL_DIR, variant=args.variant, voices_dir=VOICES, port=0,
    )

    t = time.time()
    model = srv.load_model()          # 内含 wetext patch + rl 权重硬链 + fp16
    print(f'[probe] model loaded in {time.time() - t:.2f}s sample_rate={model.sample_rate}', flush=True)

    pair = srv._voice_pair(args.voice)
    if not pair:
        print(f'[probe] VOICE MISSING: {args.voice} under {VOICES}', flush=True)
        return 2
    wav_path, txt_path = pair
    prompt_text = open(txt_path, 'r', encoding='utf-8').read().strip() + '[token]'

    sr = int(model.sample_rate)
    stream = bool(args.stream)
    print(f'[probe] begin stream={stream} speed={args.speed} text={args.text!r}', flush=True)

    t0 = time.time()
    rows = []
    total = 0
    first_at = None
    for i, out in enumerate(model.inference_zero_shot(
        args.text, prompt_text, wav_path, stream=stream, speed=args.speed,
    )):
        sp = out['tts_speech']
        n = int(sp.shape[-1])
        dt = time.time() - t0
        if first_at is None:
            first_at = dt
        total += n
        rows.append((i, n, dt))
        print(f'[probe] chunk={i:<3} samples={n:<7} dur={n / sr:6.3f}s at={dt:7.3f}s cum={total}', flush=True)

    wall = time.time() - t0
    audio = total / sr
    print('---', flush=True)
    print(f'[probe] chunks={len(rows)} total_samples={total} audio={audio:.3f}s wall={wall:.3f}s', flush=True)
    print(f'[probe] first_chunk_at={first_at if first_at is not None else -1:.3f}s', flush=True)
    if audio:
        print(f'[probe] RTF={wall / audio:.3f}x', flush=True)

    if len(rows) >= 2:
        sizes = [r[1] for r in rows]
        print(f'[probe] constant_size={len(set(sizes)) == 1}', flush=True)
        print(f'[probe] monotonically_increasing={all(sizes[i] > sizes[i - 1] for i in range(1, len(sizes)))}', flush=True)
        print(f'[probe] sizes={sizes[:30]}{" ..." if len(sizes) > 30 else ""}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
