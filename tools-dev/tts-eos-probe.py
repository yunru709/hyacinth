#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EOS 行为取证探针 v2 —— 复用 server.py 的 load_model()，保证与线上同一条加载路径。

为什么 v1 失败（2026-10-25 13:05）：
  1. rl 变体目录里只有 llm.rl.pt，没有 llm.pt；官方 CosyVoice3.__init__ 写死载 llm.pt
     ⇒ server.py 里有「临时硬链 llm.rl.pt -> llm.pt」的逻辑，探针自己 new 就漏了。
  2. 不走 _patch_wetext_offline() ⇒ wetext 联网校验失败 ⇒ "no frontend is avaliable"。
  直接 import server.py 复用其 _ARGS / load_model()，两个坑一起消掉。

要回答的问题：
  A. ignore_eos 屏蔽的到底是 EOS 还是 SOS？
     llm.py sampling_ids: if ignore_eos: weighted_scores[self.speech_token_size] = -inf
     而 CosyVoice3LM: sos = speech_token_size+0, eos_token = speech_token_size+1
     ⇒ 若真屏蔽的是 sos，则 min_len 形同虚设，EOS 随时可发（解释 0.12s/3token）。
  B. 撞满 max_len 的那几次，模型是真的从不发 EOS，还是发的 id 不在 stop_token_ids？

用法：python -u tts-eos-probe.py --fp16 1 --repeat 3 [--text ...]
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
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--voice", default="FlutterShy")
    ap.add_argument("--text", default="你好，孑遗。")
    args = ap.parse_args()

    os.environ["COSYVOICE_FP16"] = str(args.fp16)
    srv = load_server_module()
    srv._ARGS = argparse.Namespace(model_dir=MODEL, variant="rl",
                                   voices_dir=VOICES, port=3178)

    import torch
    import cosyvoice.llm.llm as L

    # 找 sampling_ids 的 owner class（不硬编码类名）
    owner = None
    for name in dir(L):
        obj = getattr(L, name)
        if isinstance(obj, type) and "sampling_ids" in obj.__dict__:
            owner = obj
            break
    if owner is None:
        print("[FATAL] sampling_ids owner not found"); return 2
    print(f"[probe] patching {owner.__name__}.sampling_ids", flush=True)

    REC = []
    orig = owner.sampling_ids

    def patched(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
        # 取证：ignore_eos 时被置 -inf 的那个下标是多少
        masked_idx = None
        masked_was_eos = masked_was_sos = None
        if ignore_eos:
            # 复刻上游动作，同时记录被屏蔽的绝对下标
            masked_idx = int(self.speech_token_size)
            masked_was_eos = (masked_idx == int(self.sos) + 1) if hasattr(self, "sos") else None
            masked_was_sos = (masked_idx == int(self.sos)) if hasattr(self, "sos") else None
        top = orig(self, weighted_scores, decoded_tokens, sampling, ignore_eos)
        try:
            is_stop = int(top) in set(int(x) for x in self.stop_token_ids)
        except Exception:
            is_stop = None
        REC.append({"step": len(decoded_tokens), "top": int(top),
                    "ignore_eos": bool(ignore_eos), "stop": is_stop,
                    "masked_idx": masked_idx,
                    "masked_is_sos": masked_was_sos,
                    "masked_is_eos": masked_was_eos})
        return top

    owner.sampling_ids = patched

    print(f"[probe] loading model (fp16={bool(args.fp16)}) ...", flush=True)
    t0 = time.time()
    model = srv.load_model()
    print(f"[probe] model ready in {time.time()-t0:.1f}s sample_rate={model.sample_rate}", flush=True)

    lm = model.model.llm
    print(f"[probe] speech_token_size={lm.speech_token_size} sos={lm.sos} "
          f"eos_token={getattr(lm, 'eos_token', '?')} task_id={lm.task_id} "
          f"fill_token={getattr(lm, 'fill_token', '?')}", flush=True)
    stops = sorted(int(x) for x in lm.stop_token_ids)
    print(f"[probe] stop_token_ids n={len(stops)} range={stops[0]}..{stops[-1]} "
          f"contains_sos={lm.sos in stops} contains_eos={getattr(lm,'eos_token',None) in stops}", flush=True)

    eop = chr(60) + "|endofprompt|" + chr(62)
    prompt_text = open(os.path.join(VOICES, f"{args.voice}.txt"), encoding="utf-8").read().strip() + eop
    wav_path = os.path.join(VOICES, f"{args.voice}.wav")

    fe = model.frontend
    segs = fe.text_normalize(args.text, split=True, text_frontend=True)
    print(f"[probe] text='{args.text}' segments={len(segs)}", flush=True)

    rows = []
    for r in range(args.repeat):
        REC.clear()
        tt, tt_len = fe._extract_text_token(segs[0])
        n_text = int(tt_len.item())
        min_len, max_len = int(n_text * 2), int(n_text * 20)
        t1 = time.time()
        outs = list(model.inference_zero_shot(args.text, prompt_text, wav_path, stream=False, speed=1.0))
        wall = time.time() - t1
        audio = sum(o["tts_speech"].shape[1] for o in outs) / model.sample_rate

        calls = len(REC)
        stop_hits = [c for c in REC if c["stop"]]
        n_gen = stop_hits[0]["step"] if stop_hits else calls
        verdict = "eos" if stop_hits else ("max_len" if calls >= max_len else "?")
        print(f"\n  run{r}: n_text={n_text} min_len={min_len} max_len={max_len}", flush=True)
        print(f"         generated={n_gen} stop={verdict}"
              f"{' stop_id=' + str(stop_hits[0]['top']) if stop_hits else ''} calls={calls}", flush=True)
        print(f"         audio={audio:.2f}s expect={n_gen*0.04:.2f}s wall={wall:.2f}s", flush=True)
        if REC:
            print(f"         first8 ids={[c['top'] for c in REC[:8]]}", flush=True)
            mi = {c["masked_idx"] for c in REC if c["masked_idx"] is not None}
            ms = {c["masked_is_sos"] for c in REC if c["masked_is_sos"] is not None}
            me = {c["masked_is_eos"] for c in REC if c["masked_is_eos"] is not None}
            print(f"         ignore_eos 屏蔽下标={mi} 是sos?={ms} 是eos?={me}", flush=True)
        rows.append((n_gen, verdict, audio))

    print("\n=== SUMMARY ===")
    for i, (n, v, a) in enumerate(rows):
        print(f"  run{i}: tokens={n:4d} stop={v:8s} audio={a:5.2f}s")
    g = [n for n, _, _ in rows]
    print(f"  token spread = {max(g)-min(g)} (min={min(g)} max={max(g)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
