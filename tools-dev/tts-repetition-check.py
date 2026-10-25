#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重复检测：长音频的尾部是不是在"复读"？

为什么做这个（2026-10-25）：
  tools-dev/audio-content.log 已证明长样本 **100% 是有声的**（不是静音填充）
  ⇒ 模型确实在"继续说"。但「继续说」有两种完全不同的成因，修法相反：
    (a) 复读（把前面说过的内容又念一遍）⇒ 该加 repetition penalty / 截尾
    (b) 真的多说内容（多念了字）⇒ 该收紧 max_len / 改 prompt
  这一步把 (a)/(b) 分开。

算法：
  取 log-mel（hop 与 speech token 的 40 ms 对齐），把时间轴按 0.4 s 切窗口，
  计算「任意两窗口的余弦相似度」矩阵，排除对角带（自身/相邻）后看最大相似度。
  若存在 t 与 t-Δ（Δ 足够大）相似度 ≈ 1.0 ⇒ 复读，并给出重复起点。

判据（先写死）：
  max_offdiag_sim >= 0.95 且 Δ >= 1.0 s  ⇒ 判为复读
  否则                                    ⇒ 非复读（内容真的多）

用法：python -u tts-repetition-check.py [--dir tools-dev/audio-content]
"""
import argparse, glob, os, sys

import numpy as np
import torch
import torchaudio

WIN = 0.4      # 秒
HOP = 0.1      # 秒
MIN_GAP = 1.0  # 秒，短于此的"相似"属于正常音素重复，不算复读


def logmel(path):
    w, sr = torchaudio.load(path)
    if w.shape[0] > 1:
        w = w.mean(dim=0, keepdim=True)
    if sr != 24000:
        w = torchaudio.functional.resample(w, sr, 24000)
    mel = torchaudio.transforms.MelSpectrogram(
        sample_rate=24000, n_fft=1024, hop_length=240, n_mels=40)(w)  # hop=240 @24k = 10 ms
    return torch.log(mel.clamp_min(1e-6)).squeeze(0)                  # (n_mels, T)


def analyze(path):
    m = logmel(path)
    T = m.shape[1]
    win = int(WIN * 100)   # hop=240 ⇒ 100 帧/秒
    hop = int(HOP * 100)
    if T < win * 3:
        return None
    idx = list(range(0, T - win + 1, hop))
    feats = torch.stack([m[:, i:i + win].flatten() for i in idx])
    feats = torch.nn.functional.normalize(feats, dim=1)
    sim = feats @ feats.T                    # (N, N)
    N = sim.shape[0]
    gap = int(MIN_GAP / HOP)
    # ⚠️ 2026-10-25 修 bug：初版写成 `for j in range(max(0, i-gap), i)` ——
    # 这把 j 限制在「距 i 不超过 MIN_GAP」的窗口里，**恰好把要查的远距离复读
    # 排除掉了**，报出来的 0.96+ 全是相邻音节的正常重复 ⇒ 结论「正常」是假绿。
    # 正确范围：j 必须**早于 i 至少 MIN_GAP**，即 j < i - gap。
    best, bi, bj = 0.0, -1, -1
    for i in range(N):
        upper = i - gap
        if upper <= 0:
            continue
        window = sim[i, :upper]
        s, j = float(window.max()), int(window.argmax())
        if s > best:
            best, bi, bj = s, i, j
    return {
        "dur": T / 100.0,
        "max_sim": best,
        "t_late": bi * HOP if bi >= 0 else -1,
        "t_early": bj * HOP if bj >= 0 else -1,
        "gap": (bi - bj) * HOP if bi >= 0 else -1,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=r"C:\Users\74689\Desktop\Agent\hyacinth\tools-dev\audio-content")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.dir, "*.wav")))
    if not files:
        print("no wav found"); return 1
    print(f"{'file':16s} {'时长':>6s} {'最大自相似':>10s} {'间隔':>6s}  判定")
    for f in files:
        r = analyze(f)
        if r is None:
            print(f"{os.path.basename(f):16s}  太短，跳过"); continue
        rep = r["max_sim"] >= 0.95 and r["gap"] >= MIN_GAP
        print(f"{os.path.basename(f):16s} {r['dur']:6.2f}s {r['max_sim']:10.4f} "
              f"{r['gap']:6.2f}s  {'复读' if rep else '正常'} "
              f"(t={r['t_late']:.1f}s ≈ t={r['t_early']:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
