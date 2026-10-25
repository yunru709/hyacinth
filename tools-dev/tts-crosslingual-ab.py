#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨语言路径 + max_ratio 收紧 → EOS/时长稳定性 归因实验（决定性一轮）。

已有结论（2026-10-25 13:2x，均已活体验证）：
  · bug-1：server.py 的 endofprompt 曾被写成字面量 ⇒ 已修
  · bug-2：上游 ignore_eos 屏蔽 sos 而非 eos ⇒ 已加 _patch_min_len_guard() 修好
  · RAS 采样回退不是 runaway 根因（纯 nucleus 照样撞 max_len，tools-dev/sampling-ab.log）
  · 参考音长度不是根因（397 vs 87 token 抖动同量级）
  · fp16 不是根因（fp32 照样撞 16.80s）

本轮两臂（对应两个仍未检验的假设）：
  H-A 【路径】当前代码一律 `inference_zero_shot`：把 397 个**英文** speech token 与英文文稿
       拼进 LLM，再去合成中文。CosyVoice 为此专门提供 `inference_cross_lingual`，
       其 frontend_cross_lingual **删除** prompt_text / llm_prompt_speech_token
       （见 cosyvoice/cli/frontend.py:191-198）⇒ LLM 只看到待合成中文。
       若跨语言臂显著更稳 ⇒ 应改用该路径（这也是文档 §4.4「跨语言参考」的正解）。
  H-B 【上限】runaway 表现为「跑满 max_len = N*20」。收紧 max_token_text_ratio
       可物理封顶（21 字：420→168 token，16.8s→6.7s）。注意：早期「收紧 ratio 全崩」
       的结论是**污染实验**（跑在 bug-1 已坏的环境里），从未被公正检验过。

实验臂：
  1 zero_shot   （当前线上行为，max_ratio=20）
  2 cross_lingual（跨语言正解路径，不传 prompt_text/prompt_speech_token）
  3 zero_shot + max_ratio=8（物理封顶对照）

判据（先写死，避免事后凑结论）：
  ok    = 音频 >= 0.3s
  稳定  = 同一文本 N 次里 audio 的极差 <= 1.0s 且无人撞满 max_len
  H-A 成立 ⇔ arm2 稳定 而 arm1 不稳定
  H-B 成立 ⇔ arm3 的 audio 上限 <= 理论封顶（N*8*40ms）且不再出现 16.80s

⚠️ 插桩教训：先前探针在 load_model() 之前 patch sampling_ids，被 server.py 里的
   _patch_min_len_guard() 覆盖 ⇒ 记录恒为空（tok=0）。本轮改为**加载完成后再插桩**。

用法：python -u tts-crosslingual-ab.py [--fp16 1] [--repeat 3]
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
    ap.add_argument("--repeat", type=int, default=3)
    args = ap.parse_args()
    os.environ["COSYVOICE_FP16"] = str(args.fp16)

    srv = load_server_module()
    srv._ARGS = argparse.Namespace(model_dir=MODEL, variant="rl", voices_dir=VOICES, port=3178)

    print(f"[probe] loading model (fp16={bool(args.fp16)}) ...", flush=True)
    model = srv.load_model()          # ← 先加载（含 _patch_min_len_guard）
    import cosyvoice.llm.llm as L

    owner = next((getattr(L, n) for n in dir(L)
                  if isinstance(getattr(L, n), type) and "sampling_ids" in getattr(L, n).__dict__), None)
    if owner is None:
        print("[FATAL] sampling_ids owner not found"); return 2

    # ── 插桩必须在 load_model() 之后 ──
    REC = []
    cur_sid = owner.sampling_ids   # 已被 min_len guard 包过的那份

    def patched(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
        top = cur_sid(self, weighted_scores, decoded_tokens, sampling, ignore_eos)
        try:
            is_stop = int(top) in set(int(x) for x in self.stop_token_ids)
        except Exception:
            is_stop = None
        REC.append((len(decoded_tokens), int(top), is_stop))
        return top
    owner.sampling_ids = patched

    # max_ratio 覆盖（仅 arm3）
    # ⚠️ 不能打 owner.inference：owner 是 TransformerLM，而 CosyVoice3 实际走的是
    #    Qwen2LM.inference（同名方法把父类的影子掉了）⇒ 打在 TransformerLM 上等于没打。
    #    这里按「实际实例的类」定位真正的 inference。
    llm_cls = type(model.model.llm)
    orig_inf = llm_cls.inference
    print(f"[probe] patching {llm_cls.__name__}.inference (owner for sampling_ids = {owner.__name__})", flush=True)

    def make_inf(ratio):
        def inf(self, *a, **kw):
            kw["max_token_text_ratio"] = ratio
            return orig_inf(self, *a, **kw)
        return inf

    fe = model.frontend
    llm = model.model.llm
    eop = chr(60) + "|endofprompt|" + chr(62)
    prompt_text = open(os.path.join(VOICES, "FlutterShy.txt"), encoding="utf-8").read().strip() + eop
    wav_path = os.path.join(VOICES, "FlutterShy.wav")

    def run_zero_shot(text):
        return list(model.inference_zero_shot(text, prompt_text, wav_path, stream=False, speed=1.0))

    def run_cross_lingual(text):
        return list(model.inference_cross_lingual(text, wav_path, stream=False, speed=1.0))

    ARMS = [
        ("1 zero_shot",      run_zero_shot, None),
        ("2 cross_lingual",  run_cross_lingual, None),
        ("3 zs+max_ratio=8", run_zero_shot, 8),
    ]

    results = {}
    for label, text in TEXTS:
        segs = fe.text_normalize(text, split=True, text_frontend=True)
        tt, tt_len = fe._extract_text_token(segs[0])
        n_text = int(tt_len.item())
        min_len, max_len = int(n_text * 2), int(n_text * 20)
        print(f"\n########## {label} n_text={n_text} min_len={min_len} max_len={max_len} ##########", flush=True)
        for arm_name, fn, ratio in ARMS:
            llm_cls.inference = make_inf(ratio) if ratio else orig_inf
            rows = []
            for r in range(args.repeat):
                REC.clear()
                t0 = time.time()
                try:
                    outs = fn(text)
                    audio = sum(o["tts_speech"].shape[1] for o in outs) / model.sample_rate
                    err = ""
                except Exception as e:
                    audio, err = 0.0, f"{type(e).__name__}: {str(e)[:60]}"
                wall = time.time() - t0
                stops = [c for c in REC if c[2]]
                n_gen = stops[0][0] if stops else len(REC)
                cap = max_len if not ratio else int(n_text * ratio)
                verdict = "eos" if stops else ("max_len" if len(REC) >= cap else "cut?")
                print(f"  {arm_name:17s} r{r}: tok={n_gen:4d} {verdict:8s} audio={audio:5.2f}s wall={wall:5.2f}s {err}", flush=True)
                if not err:
                    rows.append((n_gen, verdict, audio))
            results[(label, arm_name)] = rows
    llm_cls.inference = orig_inf

    print("\n=== SUMMARY ===")
    for label, _ in TEXTS:
        print(f"\n[{label}]")
        for arm_name, _fn, _r in ARMS:
            rows = results[(label, arm_name)]
            if not rows:
                print(f"  {arm_name:17s}: all failed"); continue
            a = [x[2] for x in rows]
            hit = sum(1 for x in rows if x[1] == "max_len")
            spread = max(a) - min(a)
            stable = "STABLE" if (spread <= 1.0 and hit == 0) else "unstable"
            print(f"  {arm_name:17s}: audio {min(a):.2f}~{max(a):.2f}s spread={spread:.2f}s "
                  f"hit_max={hit}/{len(rows)} => {stable}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
