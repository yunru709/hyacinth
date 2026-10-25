#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采样策略 → EOS/时长稳定性 归因实验。

线索（2026-10-25，读 cosyvoice/utils/common.py）：
    def ras_sampling(weighted_scores, decoded_tokens, sampling, top_p=0.8, top_k=25,
                     win_size=10, tau_r=0.1):
        top_ids = nucleus_sampling(weighted_scores, top_p=top_p, top_k=top_k)
        rep_num = (decoded_tokens[-win_size:] == top_ids).sum().item()
        if rep_num >= win_size * tau_r:          # 10 * 0.1 = 1.0
            weighted_scores[top_ids] = -inf
            top_ids = random_sampling(weighted_scores, decoded_tokens, sampling)   # ← 全词表！
        return top_ids

`win_size*tau_r` = **1.0**，而 rep_num 是整数 ⇒ 只需「last10 里出现过 1 次」就开闸。
语音 token 天然爱重复（静音、延长音）⇒ 该分支可能被高频触发，把 top-k/p 的约束整个绕开，
退化成在 6761 个 token 上均匀乱采 —— 这既可能是「跑满 max_len 不发 EOS」的来源，
也可能是音质不稳的来源。

实验臂（同进程、同模型、同文本，只换 sampling 可调用对象）：
  A ras-default   yaml 原样（win=10, tau=0.1 ⇒ 阈值 1）
  B nucleus-only  完全去掉 RAS 回退，只做 top_p/top_k
  C ras-lenient   阈值抬到 rep_num >= 6（tau_r=0.6）

同时统计 A 臂的 RAS 触发率（patch random_sampling 计数）。
判据（先写死）：
  · 若 B/C 的 token 数 spread 明显小于 A，且 hit_max_len 归零 ⇒ RAS 阈值是主因
  · 若三者相当 ⇒ RAS 无关，回到模型本身

用法：python -u tts-sampling-ab.py [--fp16 1] [--repeat 4]
"""
import argparse, importlib.util, os, sys, time

PYENV = r"C:\Users\74689\.agent\envs\CosyVoice"
MODEL = r"C:\Users\74689\.agent\models\tts\cosyvoice3"
VOICES = r"C:\Users\74689\.agent\models\voices"
SERVER = r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py"
sys.path.insert(0, PYENV)

TEXTS = [
    ("6字", "你好，孑遗。"),
    ("21字", "现在我在测试流式输出，看看首包到底有多快。"),
]


def load_server_module():
    spec = importlib.util.spec_from_file_location("cv_server", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp16", type=int, default=1)
    ap.add_argument("--repeat", type=int, default=4)
    args = ap.parse_args()
    os.environ["COSYVOICE_FP16"] = str(args.fp16)

    srv = load_server_module()
    srv._ARGS = argparse.Namespace(model_dir=MODEL, variant="rl", voices_dir=VOICES, port=3178)

    import cosyvoice.llm.llm as L
    import cosyvoice.utils.common as C

    owner = next((getattr(L, n) for n in dir(L)
                  if isinstance(getattr(L, n), type) and "sampling_ids" in getattr(L, n).__dict__), None)
    if owner is None:
        print("[FATAL] sampling_ids owner not found"); return 2

    # 记录每次被真实调用的 top_id（判 EOS 用）
    REC = []
    orig_sid = owner.sampling_ids

    def patched_sid(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
        top = orig_sid(self, weighted_scores, decoded_tokens, sampling, ignore_eos)
        try:
            is_stop = int(top) in set(int(x) for x in self.stop_token_ids)
        except Exception:
            is_stop = None
        REC.append((len(decoded_tokens), int(top), is_stop))
        return top

    owner.sampling_ids = patched_sid

    # RAS 触发计数
    RAS_HITS = [0]
    orig_rand = C.random_sampling

    def counting_rand(weighted_scores, decoded_tokens, sampling):
        RAS_HITS[0] += 1
        return orig_rand(weighted_scores, decoded_tokens, sampling)

    C.random_sampling = counting_rand

    def arm_nucleus(ws, dt, s):
        return C.nucleus_sampling(ws, top_p=0.8, top_k=25)

    def arm_ras_lenient(ws, dt, s):
        return C.ras_sampling(ws, dt, s, top_p=0.8, top_k=25, win_size=10, tau_r=0.6)

    ARMS = [("A ras-default", C.ras_sampling), ("B nucleus-only", arm_nucleus), ("C ras-lenient", arm_ras_lenient)]

    print(f"[probe] loading model (fp16={bool(args.fp16)}) ...", flush=True)
    model = srv.load_model()
    llm = model.model.llm
    fe = model.frontend
    eop = chr(60) + "|endofprompt|" + chr(62)
    prompt_text = open(os.path.join(VOICES, "FlutterShy.txt"), encoding="utf-8").read().strip() + eop
    wav_path = os.path.join(VOICES, "FlutterShy.wav")

    results = {}
    for label, text in TEXTS:
        segs = fe.text_normalize(text, split=True, text_frontend=True)
        tt, tt_len = fe._extract_text_token(segs[0])
        n_text = int(tt_len.item())
        min_len, max_len = int(n_text * 2), int(n_text * 20)
        print(f"\n########## {label} n_text={n_text} min_len={min_len} max_len={max_len} ##########", flush=True)
        for arm_name, fn in ARMS:
            llm.sampling = fn          # 切换实验臂
            rows = []
            for r in range(args.repeat):
                REC.clear(); RAS_HITS[0] = 0
                t0 = time.time()
                try:
                    outs = list(model.inference_zero_shot(text, prompt_text, wav_path, stream=False, speed=1.0))
                    audio = sum(o["tts_speech"].shape[1] for o in outs) / model.sample_rate
                    err = ""
                except Exception as e:
                    audio, err = 0.0, f"{type(e).__name__}: {str(e)[:50]}"
                wall = time.time() - t0
                stops = [c for c in REC if c[2]]
                n_gen = stops[0][0] if stops else len(REC)
                verdict = "eos" if stops else ("max_len" if len(REC) >= max_len else "cut?")
                print(f"  {arm_name:15s} r{r}: tok={n_gen:4d} {verdict:8s} audio={audio:5.2f}s "
                      f"wall={wall:5.2f}s ras={RAS_HITS[0]:3d} {err}", flush=True)
                if not err:
                    rows.append((n_gen, verdict, audio, RAS_HITS[0]))
            results[(label, arm_name)] = (rows, max_len)

    print("\n=== SUMMARY ===")
    for label, _ in TEXTS:
        print(f"\n[{label}]")
        for arm_name, _fn in ARMS:
            rows, max_len = results[(label, arm_name)]
            if not rows:
                print(f"  {arm_name:15s}: all failed"); continue
            g = [r[0] for r in rows]; a = [r[2] for r in rows]
            hit = sum(1 for r in rows if r[1] == "max_len")
            ras = [r[3] for r in rows]
            print(f"  {arm_name:15s}: n={len(rows)} tok {min(g)}~{max(g)} spread={max(g)-min(g):4d} "
                  f"| audio {min(a):.2f}~{max(a):.2f}s | hit_max={hit}/{len(rows)} | ras={ras}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
