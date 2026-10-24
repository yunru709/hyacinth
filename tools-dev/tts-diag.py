#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 推理链形状探针 —— 一次打印从 wav 到 mel 的每个张量实际形状。

为什么需要它（2026-10-25）：/tts 六个不同长度的用例全部返回同一句
    RuntimeError: Calculated padded input size per channel: (3). Kernel size: (4).
traceback 只能指到 hift.f0_predictor 收到 3 帧 mel，但「3 帧」的来源有三种可能，
从这一行完全无法区分：
    a) 参考音特征提取坏掉（speech_feat 本来就只有 3 帧）
    b) LLM 只生成了 3 个 speech token
    c) flow 输出被 token_len 截断
本脚本把每一环的形状打出来，一次定位。**不要靠读代码推断形状** —— 这个坑已经
栽过一次（先验假设被 traceback 位置带偏）。

用法：python -u tools-dev/tts-diag.py [--voice FlutterShy] [--text 你好]
环境：需要 PYTHONPATH 指向 CosyVoice 仓库根 + third_party/Matcha-TTS。
"""

import argparse
import os
import traceback


def _sh(x):
    """形状摘要：tensor / list / tuple 都能吃。"""
    if hasattr(x, "shape"):
        return f"{tuple(x.shape)}:{getattr(x, 'dtype', '')}"
    if isinstance(x, (list, tuple)):
        return f"{type(x).__name__}[{len(x)}]"
    if hasattr(x, "__len__"):
        return f"{type(x).__name__}(len={len(x)})"
    return repr(x)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=os.path.join(os.path.expanduser("~"), ".agent", "models", "tts", "cosyvoice3"))
    ap.add_argument("--voices-dir", default=os.path.join(os.path.expanduser("~"), ".agent", "models", "voices"))
    ap.add_argument("--voice", default="FlutterShy")
    ap.add_argument("--text", default="你好，孑遗。")
    ap.add_argument("--fp32", action="store_true", help="关掉 fp16（对照用）")
    args = ap.parse_args()

    from cosyvoice.cli.cosyvoice import CosyVoice3
    from cosyvoice.utils.file_utils import load_wav

    print("[diag] loading model ...", flush=True)
    m = CosyVoice3(args.model_dir, load_trt=False, fp16=not args.fp32)
    fe = m.frontend
    print(f"[diag] sample_rate={m.sample_rate} fp16={m.fp16} spk2info_keys={list(getattr(fe, 'spk2info', {}) or [])}", flush=True)

    wav = os.path.join(args.voices_dir, args.voice + ".wav")
    txt = os.path.join(args.voices_dir, args.voice + ".txt")
    print(f"[diag] voice={args.voice} wav={wav}", flush=True)
    print(f"[diag]   exists={os.path.isfile(wav)} size={os.path.getsize(wav) if os.path.isfile(wav) else 0} mtime={os.path.getmtime(wav) if os.path.isfile(wav) else 0}", flush=True)
    prompt_text = open(txt, encoding="utf-8").read().strip() + "[token]"
    print(f"[diag] prompt_text len={len(prompt_text)} repr={prompt_text[:160]!r}", flush=True)

    # ── 1) 原始加载（两个采样率各看一次：token 走 16k，feat 走 24k）──
    for sr in (16000, 24000):
        try:
            sp = load_wav(wav, sr)
            print(f"[diag] load_wav({sr}) -> {_sh(sp)} dur={sp.shape[1] / sr:.2f}s", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[diag] load_wav({sr}) FAILED {type(e).__name__}: {e}", flush=True)

    # ── 2) 三项参考音特征 ──
    for name in ("_extract_speech_feat", "_extract_speech_token", "_extract_spk_embedding"):
        try:
            r = getattr(fe, name)(wav)
            if isinstance(r, tuple):
                print(f"[diag] {name} -> " + " , ".join(_sh(x) for x in r), flush=True)
            else:
                print(f"[diag] {name} -> {_sh(r)}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[diag] {name} FAILED {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()

    # ── 3) 文本侧 ──
    norm = fe.text_normalize(prompt_text, split=False, text_frontend=True)
    print(f"[diag] normalize(prompt_text) -> len={len(norm)} same={norm == prompt_text}", flush=True)
    chunks = fe.text_normalize(args.text, split=True, text_frontend=True)
    print(f"[diag] normalize(text) -> {len(chunks)} chunk(s): {[c[:30] for c in chunks]}", flush=True)
    for i, c in enumerate(chunks):
        tt, tl = fe._extract_text_token(c)
        print(f"[diag]   chunk[{i}] text_token {_sh(tt)} len={_sh(tl)}", flush=True)

    # ── 4) frontend_zero_shot 全量形状 ──
    mi = fe.frontend_zero_shot(chunks[0], prompt_text, wav, m.sample_rate, "")
    for k, v in mi.items():
        print(f"[diag] model_input[{k}] = {_sh(v)}", flush=True)

    # ── 5) 拦 token2wav 看 LLM→flow 的交界处（这是决定 3 帧的关键一跳）──
    orig = m.model.token2wav

    def wrapped(*a, **kw):
        for k, v in kw.items():
            if hasattr(v, "shape") or isinstance(v, (list, tuple)):
                print(f"[diag] token2wav.{k} = {_sh(v)}", flush=True)
        out = orig(*a, **kw)
        if isinstance(out, tuple) and out and hasattr(out[0], "shape"):
            print(f"[diag] token2wav -> wav {_sh(out[0])}", flush=True)
        return out

    m.model.token2wav = wrapped
    try:
        outs = list(m.model.tts(**mi, stream=False, speed=1.0))
        for i, o in enumerate(outs):
            print(f"[diag] tts out[{i}] tts_speech {_sh(o['tts_speech'])}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[diag] model.tts FAILED {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
    finally:
        m.model.token2wav = orig

    # ── 6) 走官方 inference_zero_shot 复核（同一进程，排除 HTTP 层干扰）──
    try:
        outs = list(m.inference_zero_shot(args.text, prompt_text, wav, stream=False, speed=1.0))
        print(f"[diag] inference_zero_shot -> {len(outs)} seg(s): "
              + ", ".join(_sh(o['tts_speech']) for o in outs), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[diag] inference_zero_shot FAILED {type(e).__name__}: {e}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
