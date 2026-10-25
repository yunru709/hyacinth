#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""参考音长度 → EOS 行为归因实验。

背景（2026-10-25）：
  唯一音色 FlutterShy = 15.86 s 英文稿 ⇒ speech_token ≈ 396 个，作为 prompt 拼进 LLM 上下文。
  合成短中文时会**偶发跑满 max_len = N*20** 而全程不发 EOS（21 字 → 16.80s 整，多次复现），
  fp16 / fp32 都出现，故非精度问题。怀疑「参考音过长 ⇒ 上下文被参考 token 主导 ⇒ 不会收尾」。

对照设计（同一进程、同一模型、同一句待合成文本，只改参考音）：
  ref-long   FlutterShy.wav  15.86 s 英文（396 token）
  ref-short  asset/zero_shot_prompt.wav  3.48 s 中文（官方 example.py 用的参考音，约 87 token）
两段参考音都使用**各自对应的正确文字稿**（这是 CosyVoice zero-shot 的硬要求，
不给对文稿 ⇒ 特征提取出来就是垃圾，结论无意义）。

指标：每次的生成 token 数 + 停止原因（eos / max_len）+ 音频时长。
判据（先写死，避免事后凑结论）：
  · 若 ref-short 的 token 数 spread 明显小于 ref-long（且不撞 max_len）⇒ 参考音长度是主因
  · 若两者相当 ⇒ 该假设不成立，runaway 另有来源

用法：python -u tts-prompt-len-ab.py [--fp16 1] [--repeat 4] [--text "你好，孑遗。"]
"""
import argparse, importlib.util, os, sys, time

PYENV = r"C:\Users\74689\.agent\envs\CosyVoice"
MODEL = r"C:\Users\74689\.agent\models\tts\cosyvoice3"
VOICES = r"C:\Users\74689\.agent\models\voices"
SERVER = r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py"
sys.path.insert(0, PYENV)


def load_server_module():
    spec = importlib.util.spec_from_file_location("cv_server", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp16", type=int, default=1)
    ap.add_argument("--repeat", type=int, default=4)
    ap.add_argument("--text", default="你好，孑遗。")
    args = ap.parse_args()
    os.environ["COSYVOICE_FP16"] = str(args.fp16)

    srv = load_server_module()
    srv._ARGS = argparse.Namespace(model_dir=MODEL, variant="rl", voices_dir=VOICES, port=3178)

    import cosyvoice.llm.llm as L
    owner = next((getattr(L, n) for n in dir(L)
                  if isinstance(getattr(L, n), type) and "sampling_ids" in getattr(L, n).__dict__), None)
    if owner is None:
        print("[FATAL] sampling_ids owner not found"); return 2

    REC = []
    orig = owner.sampling_ids

    def patched(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
        top = orig(self, weighted_scores, decoded_tokens, sampling, ignore_eos)
        try:
            is_stop = int(top) in set(int(x) for x in self.stop_token_ids)
        except Exception:
            is_stop = None
        REC.append((len(decoded_tokens), int(top), is_stop))
        return top

    owner.sampling_ids = patched

    print(f"[probe] loading model (fp16={bool(args.fp16)}) ...", flush=True)
    model = srv.load_model()
    fe = model.frontend
    eop = chr(60) + "|endofprompt|" + chr(62)

    REFS = [
        ("ref-long ", os.path.join(VOICES, "FlutterShy.wav"), os.path.join(VOICES, "FlutterShy.txt")),
        ("ref-short", os.path.join(PYENV, "asset", "zero_shot_prompt.wav"), None),
    ]
    # 官方 example.py 用的文稿（asset/zero_shot_prompt.wav 对应的就是它）
    OFFICIAL_TXT = "希望你以后能够做的比我还好呦。"

    segs = fe.text_normalize(args.text, split=True, text_frontend=True)
    tt, tt_len = fe._extract_text_token(segs[0])
    n_text = int(tt_len.item())
    min_len, max_len = int(n_text * 2), int(n_text * 20)
    print(f"[probe] text={args.text!r} n_text={n_text} min_len={min_len} max_len={max_len}", flush=True)

    results = {}
    for label, wav, txt in REFS:
        ptext = (open(txt, encoding="utf-8").read().strip() if txt else OFFICIAL_TXT) + eop
        # 参考音自己的 token 数（量级对照）
        st, st_len = fe._extract_speech_token(wav)
        n_ref = int(st_len[0].item()) if hasattr(st_len, "__getitem__") else int(st_len)
        print(f"\n[{label}] wav={os.path.basename(wav)} ref_speech_token={n_ref}", flush=True)
        rows = []
        for r in range(args.repeat):
            REC.clear()
            t0 = time.time()
            try:
                outs = list(model.inference_zero_shot(args.text, ptext, wav, stream=False, speed=1.0))
                audio = sum(o["tts_speech"].shape[1] for o in outs) / model.sample_rate
                err = ""
            except Exception as e:
                audio, err = 0.0, f"{type(e).__name__}: {str(e)[:60]}"
            wall = time.time() - t0
            n_stop = [c for c in REC if c[2]]
            n_gen = n_stop[0][0] if n_stop else len(REC)
            verdict = "eos" if n_stop else ("max_len" if len(REC) >= max_len else "short?")
            print(f"   r{r}: tokens={n_gen:4d} stop={verdict:8s} audio={audio:5.2f}s wall={wall:5.2f}s {err}", flush=True)
            if not err:
                rows.append((n_gen, verdict, audio))
        results[label] = rows

    print("\n=== SUMMARY ===")
    for label, _ in REFS:
        rows = results[label]
        if not rows:
            print(f"{label}: all failed"); continue
        g = [r[0] for r in rows]
        a = [r[2] for r in rows]
        nmax = sum(1 for r in rows if r[1] == "max_len")
        print(f"{label}: n={len(rows)} tokens min={min(g)} max={max(g)} spread={max(g)-min(g)} "
              f"| audio {min(a):.2f}~{max(a):.2f}s | hit_max_len={nmax}/{len(rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
