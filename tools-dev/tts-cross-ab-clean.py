#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zero_shot vs cross_lingual —— 干净对照（零 monkeypatch，避免上轮 0xC0000005）。

为什么要测：
  线上代码一律走 `inference_zero_shot`：把参考音的 397 个 **英文** speech token
  与英文文稿一起拼进 LLM 上下文，再去合成中文。
  CosyVoice 另有一条 `inference_cross_lingual`：`frontend_cross_lingual()` 会
  **删掉** prompt_text / prompt_text_len / llm_prompt_speech_token /
  llm_prompt_speech_token_len（见 cosyvoice/cli/frontend.py:191-198）
  ⇒ LLM 只看待合成文本，不做「接着参考音往下说」。
  文档 §4.4「跨语言参考」推荐的正是这条路径。

上轮（tts-crosslingual-ab.py）在首次推理时原生崩溃 0xC0000005：
  同时 patch 了 sampling_ids + inference，且 inference 的 patch 打在了
  CosyVoice3LM（其 inference 继承自 Qwen2LM）上，改类属性易触发诡异问题。
  本轮思路：**一个 patch 都不打**，只比较两条官方 API 的产出分布。

判据（先写死，避免事后凑结论）：
  ok      = 音频 >= 0.3s
  稳定    = 同文本 N 次 audio 极差 <= 1.0s
  采用    ⇔ cross_lingual 稳定 且 zero_shot 不稳定（且 cross 的音色听起来没垮 —— 这个只能孑遗听）

用法：python -u tts-cross-ab-clean.py [--repeat 4]
"""
import argparse, os, sys, time

PYENV = r"C:\Users\74689\.agent\envs\CosyVoice"
MODEL = r"C:\Users\74689\.agent\models\tts\cosyvoice3"
VOICES = r"C:\Users\74689\.agent\models\voices"
sys.path.insert(0, PYENV)

TEXTS = [
    ("6字", "你好，孑遗。"),
    ("21字", "现在我在测试流式输出，看看首包到底有多快。"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=4)
    args = ap.parse_args()

    # 复用 server.py 的加载路径（rl 变体硬链 + wetext 离线补丁 + min_len guard）
    import importlib.util
    SERVER = r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py"
    spec = importlib.util.spec_from_file_location("cv_server", SERVER)
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)
    srv._ARGS = argparse.Namespace(model_dir=MODEL, variant="rl", voices_dir=VOICES, port=3178)

    print("[probe] loading model ...", flush=True)
    model = srv.load_model()

    eop = chr(60) + "|endofprompt|" + chr(62)
    prompt_text = open(os.path.join(VOICES, "FlutterShy.txt"), encoding="utf-8").read().strip() + eop
    wav_path = os.path.join(VOICES, "FlutterShy.wav")

    def dur(outs):
        return sum(o["tts_speech"].shape[1] for o in outs) / model.sample_rate

    results = {}
    for label, text in TEXTS:
        print(f"\n########## {label} ##########", flush=True)
        for arm in ("zero_shot", "cross_lingual"):
            rows = []
            for r in range(args.repeat):
                t0 = time.time()
                try:
                    if arm == "zero_shot":
                        outs = list(model.inference_zero_shot(text, prompt_text, wav_path,
                                                              stream=False, speed=1.0))
                    else:
                        outs = list(model.inference_cross_lingual(text, wav_path,
                                                                  stream=False, speed=1.0))
                    a = dur(outs)
                    err = ""
                except Exception as e:
                    a, err = 0.0, f"{type(e).__name__}: {str(e)[:70]}"
                wall = time.time() - t0
                print(f"  {arm:14s} r{r}: audio={a:5.2f}s wall={wall:5.2f}s {err}", flush=True)
                if not err:
                    rows.append(a)
            results[(label, arm)] = rows

    print("\n=== SUMMARY ===")
    for label, _ in TEXTS:
        print(f"\n[{label}]")
        for arm in ("zero_shot", "cross_lingual"):
            rows = results[(label, arm)]
            if not rows:
                print(f"  {arm:14s}: all failed"); continue
            spread = max(rows) - min(rows)
            stable = "STABLE" if spread <= 1.0 else "unstable"
            print(f"  {arm:14s}: n={len(rows)} audio {min(rows):.2f}~{max(rows):.2f}s "
                  f"spread={spread:.2f}s => {stable}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
