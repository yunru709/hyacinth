#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音频内容取证：长音频里到底有没有声音？（静音占比分析）

动机（2026-10-25）：
  一直在假设「模型不主动发 EOS ⇒ 一直说 ⇒ 时长失控」，但从没人验证过
  **那 15.32 s 里到底说了多少话**。若大部分是静音填充 / 尾部噪声，
  则根因不是「不会收尾」而是别的（flow/hift 尾巴、silence token 处理），
  修法完全不同。这一步属于「先证明现象是真的」，不是再猜一个假设。

做法：POST 到已就绪的 3178 服务，把返回的 WAV 落盘，
      再用 ffmpeg silencedetect 统计静音区间 → 算「有声时长 / 总时长」。

判据（先写死）：
  · 若长样本的有声时长仍 ≈ 总时长 ⇒ 模型确实在「一直说」⇒ runaway 成立
  · 若长样本有声时长明显短于总时长（尾部大段静音）⇒ 是尾巴/填充问题，与 EOS 无关

用法：python -u tts-audio-content.py [--repeat 4] [--voice FlutterShy]
"""
import argparse, json, os, re, struct, subprocess, urllib.request, wave

FFMPEG = r"C:\Python311\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
OUTDIR = r"C:\Users\74689\Desktop\Agent\hyacinth\tools-dev\audio-content"
URL = "http://127.0.0.1:3178/tts"

CASES = [
    ("3字", "你好。"),
    ("6字", "你好，孑遗。"),
    ("20字", "你好孑遗，我现在在测试语音合成的稳定性。"),
    ("21字", "现在我在测试流式输出，看看首包到底有多快。"),
]


def post(text, voice, timeout=300.0):
    body = json.dumps({"text": text, "voice": voice, "speed": 1.0}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def wav_info(data):
    """返回 (时长秒, 采样率, 通道, 位宽)。"""
    with wave.open(__import__("io").BytesIO(data), "rb") as w:
        return w.getnframes() / w.getframerate(), w.getframerate(), w.getnchannels(), w.getsampwidth()


def silence_stats(path):
    """用 ffmpeg silencedetect 返回 (有声时长, 静音时长, 静音段数)。"""
    cmd = [FFMPEG, "-hide_banner", "-i", path, "-af", "silencedetect=noise=-40dB:d=0.3", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    err = p.stderr or ""
    durs = [float(m) for m in re.findall(r"silence_duration:\s*([0-9.]+)", err)]
    return sum(durs), len(durs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=4)
    ap.add_argument("--voice", default="FlutterShy")
    args = ap.parse_args()
    os.makedirs(OUTDIR, exist_ok=True)

    for tag, text in CASES:
        print(f"\n########## {tag}  {text} ##########", flush=True)
        for r in range(args.repeat):
            try:
                data = post(text, args.voice)
            except Exception as e:
                print(f"  r{r}: ERR {type(e).__name__}: {str(e)[:70]}", flush=True)
                continue
            total, sr, ch, sw = wav_info(data)
            fn = os.path.join(OUTDIR, f"{tag}_r{r}.wav")
            with open(fn, "wb") as f:
                f.write(data)
            sil, nseg = silence_stats(fn)
            voiced = max(0.0, total - sil)
            ratio = voiced / total * 100 if total > 0 else 0
            print(f"  r{r}: total={total:5.2f}s  静音={sil:5.2f}s/{nseg}段  "
                  f"有声={voiced:5.2f}s ({ratio:4.1f}%)  sr={sr} ch={ch} bw={sw*8}bit", flush=True)
    print("\n（WAV 已落盘到 tools-dev/audio-content/，可直接听或复核）", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
