#!/usr/bin/env python3
"""
CosyVoice3 本地推理服务 — hyacinth 桌面语音合成的 python 侧胶水。

职责（仅此而已）：
  - 从 --model-dir 加载 Fun-CosyVoice3 权重（base / rl 由 --variant 决定，
    对应 llm.pt / llm.rl.pt，其余权重共用）；
  - HTTP 服务：GET /health 健康检查、POST /tts {text} → audio/wav（16k~24k 采样）。

这是一个**源码内的胶水脚本**（非模型、非环境）：运行它需要外来 python 环境
（python 3.10+、torch、cosyvoice 包，见 FunAudioLLM/CosyVoice 官方仓库）——
环境由用户按需安装，hyacinth 设置页负责检测与指引。进程由 Node 侧
（src/tts/cosyvoice.ts）拉起/停止/健康检查。

用法：
  python server.py --model-dir <dir> --variant base|rl --port 3178 [--voices-dir <dir>]
"""

import argparse
import io
import os
import socket
import sys
import threading

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_ARGS = None
_MODEL = None          # CosyVoice3 实例（懒加载，首个请求前完成）
_LOCK = threading.Lock()
# 模型加载锁：与 _LOCK（推理串行化）分开 —— 加载发生在推理之前，
# 两者不能共用一把锁，否则 load_model() 里再取 _LOCK 会自死锁。
# 存在的理由见 load_model() 文档串（启动窗口内并发加载会踩 llm.pt 硬链竞态）。
_LOAD_LOCK = threading.Lock()
# 采样温度（2026-10-25 稳定性实验；默认 1.0 = 完全不动上游行为）。
# 上游 ras_sampling 收到的是 log_softmax 输出、内部又做 softmax
# ⇒ softmax(log_softmax(x)) == softmax(x) ⇒ **实际温度恒为 1.0**，
# `generation_config.json` 里的 temperature=0.7 / repetition_penalty=1.1
# 从未生效（那是 HF generate() 的配置，CosyVoice 走自实现的 ras_sampling）。
def _read_temperature():
    raw = os.environ.get("COSYVOICE_TEMPERATURE", "").strip()
    try:
        v = float(raw) if raw else 1.0
    except ValueError:
        print(f"[cosyvoice] COSYVOICE_TEMPERATURE={raw!r} 无法解析，按 1.0 处理", flush=True)
        return 1.0
    if v <= 0:
        print(f"[cosyvoice] COSYVOICE_TEMPERATURE={raw!r} 必须 > 0，按 1.0 处理", flush=True)
        return 1.0
    return v


_TEMPERATURE = _read_temperature()


def _read_rep_penalty():
    """重复惩罚（2026-10-25 稳定性实验；默认 1.0 = 完全不动上游行为）。

    ⚠️ 机理依据（不是乱试）：mel 自相似度实测 21 字长样本 **0.97 / 间隔 3.1 s**
    ⇒ 长音频的实质是**把刚说过的话再说一遍**（复读），而非静音填充（静音占比实测 0%）。
    `generation_config.json` 里声明了 repetition_penalty=1.1，但 CosyVoice 走的是
    自实现的 ras_sampling，**那个参数从未被读取** ⇒ 这里把它真正接上。
    与 RAS 的区别：RAS 只在「top_id 命中最近窗口」时**屏蔽这一个 token 再重采样**，
    并不惩罚整段历史；本补丁对最近窗口内**全部**已生成 token 做乘性惩罚。
    """
    raw = os.environ.get("COSYVOICE_REP_PENALTY", "").strip()
    try:
        v = float(raw) if raw else 1.0
    except ValueError:
        print(f"[cosyvoice] COSYVOICE_REP_PENALTY={raw!r} 无法解析，按 1.0 处理", flush=True)
        return 1.0
    if v < 1.0:
        print(f"[cosyvoice] COSYVOICE_REP_PENALTY={raw!r} 必须 >= 1.0，按 1.0 处理", flush=True)
        return 1.0
    return v


_REP_PENALTY = _read_rep_penalty()
_REP_WINDOW = 128   # 只看最近这么多个 speech token（约 5 s 音频）

# ── 已排除的假设：cross_lingual 通道（2026-10-25 实测，**不要再试**）──
# 曾怀疑「参考音是英文稿、却在合成中文」导致 EOS 系统性不稳，故试上游
# inference_cross_lingual 的做法：把 prompt_text / llm_prompt_speech_token 等四样
# 从 LLM 输入里全删（见 cosyvoice/cli/frontend.py:191 frontend_cross_lingual）。
# 实测结果：**18/18 全崩**，全部 `Kernel size (4) > input size (3)`（只生成 3 帧）。
# 机理：那 396 个参考音 speech token 是 LLM 生成语音的**锚点**，删掉后模型无从下手，
#       第一帧附近就 EOS。⇒ zero_shot 是唯一可用路径，此路封死。
# 证据：tools-dev/sweep-cross.log、tools-dev/cross-server.log


def _patch_wetext_offline():
    """wetext 正则化资源本地化：CosyVoice3 的文本 frontend 硬依赖 wetext FST，
    而其 snapshot_download 每次启动都打 modelscope API 校验 —— 匿名限流时
    报错降级为 no frontend → 合成必挂（endofprompt 断言）。
    本地缓存（首次成功下载后）文件其实全齐，这里把下载函数替换为
    「缓存存在直接返回」，运行期零网络依赖。"""
    cache = os.path.join(os.path.expanduser("~"), ".cache", "modelscope",
                         "hub", "models", "pengzhendong", "wetext")
    probe = os.path.join(cache, "zh", "tn", "tagger.fst")
    if not (os.path.isfile(probe) and os.path.getsize(probe) > 10000):
        return False
    try:
        import wetext.wetext as _wt
        _wt.snapshot_download = lambda *a, **k: cache
        print("[cosyvoice] wetext resources: local cache (offline mode)", flush=True)
        return True
    except Exception:
        return False


def _patch_min_len_guard():
    """修上游 min_len 保护失效 —— 「合成时长不可控」的硬 bug 之一。

    【问题】cosyvoice/llm/llm.py 的 TransformerLM.sampling_ids：
        if ignore_eos is True:
            weighted_scores[self.speech_token_size] = -float('inf')
    而 CosyVoice3LM.__init__ 里是：
        sos       = speech_token_size + 0   (=6561)  ← 实际被屏蔽的是这个
        eos_token = speech_token_size + 1   (=6562)  ← 真正该屏蔽的
        task_id   = speech_token_size + 2
        stop_token_ids = [speech_token_size + i for i in range(200)]  (=6561..6760)
    ⇒ ignore_eos 屏蔽了**起始符**，真正的 EOS 一路放行；而 stop 集合里还有 199 个
      其他特殊 token 可当选。于是 inference_wrapper 里
      `ignore_eos=True if i < min_len else False` 这句「min_len 之前别停」
      形同虚设 —— 这是上游对 CosyVoice2 的旧布局写的代码，3 换了 token 布局没跟上。

    【实测证据】tools-dev/tts-eos-probe.py（2026-10-25）：
      同一句「你好，孑遗。」(n_text=6 ⇒ min_len=12) 多次跑出：
        · 只生成 3 个 speech token 就返回 ⇒ hift 只拿到 3 帧 mel ⇒
          `Calculated padded input size per channel: (3). Kernel size: (4)`（HTTP 500）
        · audio = 0.04 / 0.08 / 0.12 s（「一开口就断」）
      探针实测输出：`ignore_eos 屏蔽下标={6561} 是sos?=True 是eos?=False`。

    【修法】ignore_eos 时屏蔽**整组 stop_token_ids**，与调用方意图
    （i < min_len 期间不许结束）一致。运行时打补丁、不 fork 上游仓库 ——
    本文件已有 _patch_wetext_offline() 先例，同一做法。
    对照开关：COSYVOICE_MIN_LEN_GUARD=0 回到上游行为，便于 A/B 复现。
    """
    if os.environ.get("COSYVOICE_MIN_LEN_GUARD", "1") == "0":
        print("[cosyvoice] min_len guard: disabled by env", flush=True)
        return False
    try:
        from cosyvoice.llm.llm import TransformerLM
        if getattr(TransformerLM, "_min_len_guard_patched", False):
            return True
        # ⚠️ 性能：掩码必须**预计算 + 一次 masked_fill_**。
        # 初版写成「for tid in stop_token_ids: weighted_scores[tid] = -inf」，
        # 200 次标量赋值 = 200 次 kernel launch × 每个 step；长句（37 token 文本
        # 最多 740 step）实测把 wall 从 6.2 s 拖到 11.3~14.1 s（约 2 倍）。
        # 这里按 (实例, 维度, device) 缓存 bool 掩码，每 step 只发一次 fill。
        _mask_cache = {}

        def _stop_mask(self, n, device):
            key = (id(self), n, device)
            mask = _mask_cache.get(key)
            if mask is None:
                import torch
                mask = torch.zeros(n, dtype=torch.bool, device=device)
                idx = [int(x) for x in self.stop_token_ids if 0 <= int(x) < n]
                if idx:
                    mask[torch.tensor(idx, dtype=torch.long, device=device)] = True
                _mask_cache[key] = mask
            return mask

        def sampling_ids(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
            # ── 温度（可选，2026-10-25 稳定性实验）──
            # 上游传进来的 weighted_scores 已是 `log_softmax` 输出，而
            # ras_sampling → nucleus_sampling 里又做一次 `.softmax(dim=0)`。
            # 因为 softmax(log_softmax(x)) == softmax(x)，这次往返等于恒等
            # ⇒ **实际温度恰为 1.0**；`generation_config.json` 里声明的
            # temperature=0.7 / repetition_penalty=1.1 从未被使用（那条是 HF
            # generate() 的配置，CosyVoice 走的是自实现的 ras_sampling）。
            # 要真正降温，就是在采样前把 log-prob 除以 T：
            #   softmax(logp / T) == softmax(logits / T)（log_softmax 减去的
            #   logsumexp 是与 token 无关的常数，除以 T 后仍可约掉）。
            # ⚠️ **实测结论：降温不是解法，默认保持 1.0**。
            #    2026-10-25 用 T=0.7 跑同一套 sweep（tools-dev/sweep-temp07.log）：
            #      12/20/37 字确实收窄，但 **21 字反而更宽**（5.08~8.48s），
            #      且 3 字出现 **0.32 s**（比 T=1 的 0.48 s 更差）⇒ 两头都更糟。
            #    所以这个旋钮只作日后调参入口，**不要当作稳定性修复来开**。
            #    真正见效的是下面的「按期望时长重试」（见 _zero_shot_cached）。
            if _TEMPERATURE != 1.0:
                weighted_scores = weighted_scores / _TEMPERATURE
            # ── 重复惩罚（可选，2026-10-25 实验；默认 1.0 = 不动）──
            # weighted_scores 是 log-prob（恒 <= 0）⇒ 乘 >1 的 penalty 使其更负
            # = 该 token 概率更低，正好对应「惩罚已生成的 token」。
            # 只惩罚最近 _REP_WINDOW 个已生成 token；stop token 不在其中（一出现即 break），
            # 故不会误伤 EOS。
            if _REP_PENALTY != 1.0 and decoded_tokens:
                import torch
                n = weighted_scores.shape[-1]
                ids = [t for t in sorted({int(x) for x in decoded_tokens[-_REP_WINDOW:]}) if 0 <= t < n]
                if ids:
                    idx = torch.tensor(ids, dtype=torch.long, device=weighted_scores.device)
                    weighted_scores[idx] = weighted_scores[idx] * _REP_PENALTY
            if ignore_eos:
                weighted_scores.masked_fill_(_stop_mask(self, weighted_scores.shape[-1],
                                                        weighted_scores.device), -float("inf"))
            return self.sampling(weighted_scores, decoded_tokens, sampling)

        TransformerLM.sampling_ids = sampling_ids
        TransformerLM._min_len_guard_patched = True
        print("[cosyvoice] min_len guard patched (mask all stop tokens while i < min_len)", flush=True)
        return True
    except Exception as e:
        # catch 里必须打日志：静默失败会让「稳定性没改善」变成无迹可查的谜
        print(f"[cosyvoice] min_len guard patch unavailable ({type(e).__name__}: {e})", flush=True)
        return False


def _patch_token_ratio():
    """可调 [min_len, max_len] 窗口 —— 治理「短句 EOS 双峰」的实验入口。

    【为什么要动它】cosyvoice/llm/llm.py 的 Qwen2LM.inference：
        min_len = int(N * min_token_text_ratio)   # 上游默认 2
        max_len = int(N * max_token_text_ratio)   # 上游默认 20
    N = 文本 token 数，1 speech token ≈ 40 ms。默认窗口对短句极不对称：
        6 字句（N=6）⇒ 允许 [0.48 s, 4.80 s]，而自然语速只有约 1.4 s。
    实测（2026-10-25 活体 sweep，见 tools-dev/sweep-guard-v2.log）短句正是双峰失控：
        6 字 → 0.64 / 2.32 / 4.28 s（4.28 = 撞满 max_len，全程不发 EOS）
        21 字 → 5.84 / 6.52 / 16.80 s（同上）
        31 字 → 9.04 / 9.16 / 9.24 s（**稳定**）⇒ 文本越长 EOS 判据越足，短句才是重灾区。

    ⚠️ 历史包袱：2026-10-25 06:09 曾测出「收紧 ratio ⇒ 18/18 全崩」，据此记过
    「ratio 不是修法」。**那是污染实验** —— 那批跑在 bug-1（endofprompt 被写成
    字面量）已生效的坏环境里，所有请求都挂，与 ratio 无关。现已推翻，须重测。

    【用法】两个 env 都留空 ⇒ **完全不动上游行为**（默认零行为变化）：
        COSYVOICE_MIN_TOKEN_RATIO  留空 = 上游默认 2
        COSYVOICE_MAX_TOKEN_RATIO  留空 = 上游默认 20
    只覆盖显式给出且能解析成正数的那个，便于做单变量对照。

    【为什么 patch inference 而不是 sampling_ids】ratio 是 `inference(...)` 的
    形参默认值，真正被算 min_len/max_len 的地方在它内部；`model.py` 的 llm_job
    调用时**不带这两个参数** ⇒ 只能从 inference 的入口注入。
    注入点在 Qwen2LM.inference（CosyVoice3LM 继承它，见 llm.py:458/664）。
    """
    raw_max = os.environ.get("COSYVOICE_MAX_TOKEN_RATIO", "").strip()
    raw_min = os.environ.get("COSYVOICE_MIN_TOKEN_RATIO", "").strip()
    # ⚠️ 2026-10-25 修正（bug-3）：此处原本是
    #       `if not raw_max and not raw_min: return False`
    #   ⇒ 没设环境变量时**完全不 patch**，于是 `_DEFAULT_MAX_RATIO = 12`
    #   只被 server 侧算 cap 用到，**从未下发给模型** ⇒ 模型一直按上游 N×20 跑。
    #
    #   实证指纹（2026-10-25 21:37，say「孑遗，晚上好，我现在能出声说话了。」）：
    #       日志: 撞顶不重试 (text_tokens=17 dur=13.60s cap=204 帧)
    #       13.60 s / 40 ms = **340 帧 = 17 × 20**（上游默认），而 cap=204 = 17 × 12。
    #   两个数同一条日志里互相矛盾 —— 这就是「常量只算不下发」的指纹。
    #
    #   现在：max 默认就下发 12（docstring 里 ratio12 的收窄实测至此才真正生效），
    #   环境变量仍可显式覆盖（更宽/更紧都能做单变量对照）。

    def _parse(name, raw):
        try:
            v = float(raw)
        except (TypeError, ValueError):
            print(f"[cosyvoice] {name}={raw!r} 无法解析为数字，忽略", flush=True)
            return None
        if v <= 0:
            print(f"[cosyvoice] {name}={raw!r} 必须 > 0，忽略", flush=True)
            return None
        return v

    # 默认就下发 12（理由见上方 bug-3）；env 显式给出则覆盖它。
    over = {"max_token_text_ratio": _DEFAULT_MAX_RATIO}
    if raw_max:
        v = _parse("COSYVOICE_MAX_TOKEN_RATIO", raw_max)
        if v is not None:
            over["max_token_text_ratio"] = v
    if raw_min:
        v = _parse("COSYVOICE_MIN_TOKEN_RATIO", raw_min)
        if v is not None:
            over["min_token_text_ratio"] = v
    if not over:
        return False

    try:
        from cosyvoice.llm.llm import Qwen2LM
        if getattr(Qwen2LM, "_token_ratio_patched", False):
            return True

        _orig = Qwen2LM.inference

        def inference(self, *args, **kwargs):
            # setdefault：调用方显式传了值就不抢（保持可组合）
            for k, v in over.items():
                kwargs.setdefault(k, v)
            yield from _orig(self, *args, **kwargs)

        Qwen2LM.inference = inference
        Qwen2LM._token_ratio_patched = True
        print(f"[cosyvoice] token-ratio window overridden: {over}", flush=True)
        return True
    except Exception as e:
        print(f"[cosyvoice] token-ratio patch unavailable ({type(e).__name__}: {e})", flush=True)
        return False


def load_model():
    """加载 CosyVoice3（选择 base / rl 的 LLM 权重）。

    ⚠️ **必须串行化（双检锁）**。`main()` 的设计是「先 bind 监听、再由后台线程
    load_model()」——好处是重复实例能在灌 4 GB 权重之前就因端口占用退出，但代价是
    存在一个「模型未就绪」的窗口。窗口内到达的请求由处理线程调用本函数，
    于是**两个线程同时走进来**，同时执行下面的 rl 硬链逻辑：

        A: os.link(llm.rl.pt → llm.pt) → 构造中 ...
        B: 看到 llm.pt 已存在 → 不建链（link_created=False）→ 也去构造
        A: 构造完 → finally 里 os.remove(llm.pt)
        B: model.load('llm.pt') → FileNotFoundError

    实测（2026-10-25 13:49，sweep 首请求即复现）：
        `tts failed (3 chars): [Errno 2] No such file or directory: .../llm.pt` → HTTP 500。
    这正是「服务刚起来就发请求」必踩的坑，与合成参数无关。
    加锁后后到者阻塞，等 _MODEL 就绪直接命中双检返回。
    """
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _LOAD_LOCK:
        if _MODEL is not None:      # 双检：等锁期间别人可能已加载完
            return _MODEL

        from cosyvoice.cli.cosyvoice import CosyVoice3  # 官方生态

        _patch_wetext_offline()
        _patch_min_len_guard()
        _patch_token_ratio()
        print(f"[cosyvoice] loading model from {_ARGS.model_dir} (variant={_ARGS.variant}) ...", flush=True)
        # 官方构造写死载 llm.pt（base 权重）。rl-only 下载场景（llm.pt 缺、llm.rl.pt
        # 在）：先把 rl 权重硬链为 llm.pt（同盘零拷贝）让构造直接载 rl，构造完成后
        # 删链 —— 磁盘状态保持 rl-only，增量下载 base 时再写自己的 llm.pt 互不干扰。
        llm_pt = os.path.join(_ARGS.model_dir, "llm.pt")
        llm_rl = os.path.join(_ARGS.model_dir, "llm.rl.pt")
        link_created = False
        if _ARGS.variant == "rl" and not os.path.isfile(llm_pt) and os.path.isfile(llm_rl):
            os.link(llm_rl, llm_pt)
            link_created = True
        try:
            # fp16 开关走环境变量（2026-10-25 测速实验）：8 GB 卡上 fp32 实测
            # 14 字文本热态 9.3 s（RTF 0.18x，比实时慢 5.5 倍），首句 15 s。
            # 默认 1（开），设 COSYVOICE_FP16=0 可回退 fp32 做对照。
            _use_fp16 = os.environ.get("COSYVOICE_FP16", "1") != "0"
            print(f"[cosyvoice] fp16={_use_fp16}", flush=True)
            _MODEL = CosyVoice3(_ARGS.model_dir, load_trt=False, fp16=_use_fp16)
        finally:
            if link_created:
                try:
                    os.remove(llm_pt)
                except OSError:
                    pass
        print("[cosyvoice] model ready", flush=True)
        return _MODEL


def _voice_pair(voice: str):
    """解析音色 → (wav, txt) 路径对；不存在返回 None。

    主位置：--voices-dir（<models.root>/voices，用户资产目录）
    兜底：模型目录内的旧位置（prompt.* / prompts/*）—— 迁移失败或用户手动
          放回时仍可用，避免升级后突然「音色消失」。
    """
    vd = _ARGS.voices_dir
    if vd:
        wav = os.path.join(vd, f"{voice}.wav")
        txt = os.path.join(vd, f"{voice}.txt")
        if os.path.isfile(wav) and os.path.isfile(txt):
            return wav, txt
    if voice == "default":
        wav = os.path.join(_ARGS.model_dir, "prompt.wav")
        txt = os.path.join(_ARGS.model_dir, "prompt.txt")
    else:
        wav = os.path.join(_ARGS.model_dir, "prompts", f"{voice}.wav")
        txt = os.path.join(_ARGS.model_dir, "prompts", f"{voice}.txt")
    if os.path.isfile(wav) and os.path.isfile(txt):
        return wav, txt
    return None


def _first_voice_pair():
    """voices 目录里第一个可用的音色对 → (id, wav, txt)；没有则 None。

    只服务于「未显式指定音色、且 voices/default.* 缺失」这一种情况（新装机 /
    配置重置后的常态）。显式指定音色却缺失仍然报错 —— 见 synthesize() 注释。
    """
    vd = _ARGS.voices_dir
    if not vd or not os.path.isdir(vd):
        return None
    for f in sorted(os.listdir(vd)):
        if not f.lower().endswith(".wav"):
            continue
        vid = f[:-4]
        wav = os.path.join(vd, f)
        txt = os.path.join(vd, f"{vid}.txt")
        if os.path.isfile(txt):
            return vid, wav, txt
    return None


# ── 参考音特征缓存（2026-10-25 测速结论）────────────────────────
# frontend_zero_shot 每次都对 prompt.wav 重算三样**与待合成文本无关**的东西：
#   speech_feat    feat_extractor（24k 重采样 + 卷积编码）
#   speech_token   speech_tokenizer_v3.onnx（16k log-mel → 约 25 token/s）
#   spk_embedding  campplus.onnx（16k fbank 80 维）
# 参考音是固定的（FlutterShy.wav 15.9 s ⇒ 约 400 个 speech token，占满
# prompts 上下文），这三项每句白烧一遍 —— 热态 3.3~3.8 s 里很大一块就是它。
# 这里按（绝对路径, mtime, size, prompt 文本）缓存这几项 model_input，每句
# 只重算 tts_text 的 text_token。
# 对照开关：COSYVOICE_PROMPT_CACHE=0 回到官方 inference_zero_shot。
# ⚠️ 缓存里存的是 GPU tensor，取用时一律 clone —— 防 model.tts 内部的原地操作
#    把缓存污染成"第二句开始音色漂移"这种极难查的 bug。
_PROMPT_CACHE = {}
_PROMPT_CACHE_ON = os.environ.get("COSYVOICE_PROMPT_CACHE", "1") != "0"


def _prompt_input_cached(model, wav_path, prompt_text):
    """参考音 → 除 text/text_len 外的全部 model_input（命中则直接复用）。"""
    key = (os.path.abspath(wav_path), os.path.getmtime(wav_path), os.path.getsize(wav_path), prompt_text)
    hit = _PROMPT_CACHE.get(key)
    if hit is None:
        # 借官方实现算一次：这样 24k 下 speech_feat 与 speech_token 的 2× 对齐
        # 截断、zero_shot_spk_id 分支等细节都不需要我复刻（复刻必漂）。
        # tts_text 传 prompt_text 只为让 _extract_text_token 拿到非空串，随后丢弃。
        start = _now()
        mi = model.frontend.frontend_zero_shot(prompt_text, prompt_text, wav_path, model.sample_rate, "")
        mi.pop("text", None)
        mi.pop("text_len", None)
        _PROMPT_CACHE.clear()   # 单音色场景：只留最新一份，不无界增长
        _PROMPT_CACHE[key] = mi
        hit = mi
        print(
            f"[cosyvoice] prompt features cached ({os.path.basename(wav_path)}) "
            f"in {_now() - start:.2f}s: "
            f"speech_token={tuple(mi['llm_prompt_speech_token'].shape)} "
            f"speech_feat={tuple(mi['prompt_speech_feat'].shape)}",
            flush=True,
        )
    # clone：tensor 给 model.tts 用，避免原地操作回写缓存
    return {k: (v.clone() if hasattr(v, "clone") else v) for k, v in hit.items()}


def _now():
    import time
    return time.time()


_DEFAULT_MAX_RATIO = 12.0   # 上游默认 20；本项目改 12，依据见下


def _max_token_ratio():
    """读 max_token_text_ratio（与 _patch_token_ratio 同源）。

    为什么默认值从上游的 20 改成 **12**（2026-10-25 实测，不是拍脑袋）：
      · max_len = N × ratio 就是「最多生成多少个 speech token」，直接决定
        ① runaway 上限（ratio20 时 21 字可到 16.80 s）② 撞顶后重试的白跑代价。
      · 中文自然语速实测 ≈ 4.5 字/秒 ⇒ 自然时长 ≈ N/4.5 秒 ≈ **N×5.6** 个 token。
        上游 20 = 自然长度的 3.6 倍（太松），12 ≈ 2.1 倍（够宽松又不放任）。
      · 同一套 sweep（repeat=4，24 请求）对比：
          ratio20(默认) → 6 字出现 4.80 s 撞顶、21 字最大 wall **32.6 s**
          ratio12       → 全长度收窄（6 字 0.80~2.72、21 字 3.36~6.04）、
                          最大 wall **16.2 s**、24/24 USABLE
      · 3 字是最紧的一档：N=3 → cap=1.44 s，而实测自然约 0.84~1.44 s，
        确实贴边但未出现截断导致的 bad 样本（sweep-tier12.log 4/4 ok）。
    证据：tools-dev/{sweep-ratio12,sweep-tier12,ratio12-server}.log
    """
    raw = os.environ.get("COSYVOICE_MAX_TOKEN_RATIO", "").strip()
    try:
        v = float(raw) if raw else _DEFAULT_MAX_RATIO
        return v if v > 0 else _DEFAULT_MAX_RATIO
    except ValueError:
        return _DEFAULT_MAX_RATIO


# ── 撞上限重试（2026-10-25 实测结论）─────────────────────────────
# 现象：cosyvoice3 在某些句子上**不主动发 EOS**，会一路生成到 max_len = N*20 才被
# 强行截断 ⇒ 21 字句偶发 16.80 s（= 420 token × 40 ms 整，分毫不差，多次复现）。
# 已排除的原因：fp16（fp32 同样复现）、参考音长度（397 vs 87 token 抖动同量级）、
#              RAS 采样回退（纯 nucleus 同样复现）。
# 为什么用「重试」而不是「调小 max_ratio」：ratio=8 实测虽有封顶效果，但会把
#   **正常收尾的样本一起截断** —— 3 字 3/3 全部落在 0.96 s = cap（见
#   tools-dev/sweep-ratio8.log），音质代价远大于收益。而采样本身是随机的
#   （同参数同文本多次结果不同，已验证）⇒ 撞上限时重采一次多半就正常收尾。
# 判据：1 speech token = 40 ms @ 24 kHz ⇒ 960 sample/token。
#   实测补充（2026-10-25 14:0x，tools-dev/audio-content.log + repetition-check.log）：
#   · 长样本静音占比 0%（100% 有声）⇒ 不是静音填充，模型真在出声；
#   · 但用 log-mel 自相似度查重复，21 字组 **2/4 判为复读**（相似度 0.97、间隔 3.1 s）
#     ⇒ 长音频的实质是「把刚说过的话再说一遍」。故判据不能只看「是否撞满 cap」，
#     必须按**期望时长**判断：既覆盖撞顶（16.80 s），也覆盖没撞顶但明显过长（15.32 s）。
# 期望时长：中文 TTS 自然语速约 4.5 字/秒，本模型 n_text ≈ 字数（实测 6→6、21→21）。
# 上下界：
#   < 0.55× 期望 ⇒ 读音缺失（被 min_len 附近截断）
#   > 2.50× 期望 ⇒ runway / 复读
# ⚠️ 下界为什么是 0.55 而不是更宽的 0.45（2026-10-25 实测修正）：
#   初版取 0.45，结果 6 字「你好，孑遗。」跑出 **0.60 s（=0.45×，恰好卡在边界）**
#   被放行，而 ffmpeg silencedetect 测出它**有声部分只有 0.25 s**（安静占比 41%）
#   ⇒ 是缺字的坏音频。凡 ratio≈0.45 的样本都带此特征，故收紧到 0.55。
#   对当前正常样本无影响：好样本 ratio 落在 0.72~1.20（12/20/21/37 字全部），
#   3 字的 0.96~1.19 亦不受影响。
# 代价：只有判定异常时才多跑一次，正常路径零额外开销。
_MAX_RETRY = os.environ.get("COSYVOICE_MAX_RETRY", "2")
_SEC_PER_TEXT_TOKEN = 1.0 / 4.5
_DUR_MIN_FACTOR = 0.55
_DUR_MAX_FACTOR = 2.50


def _truncated(samples, max_len):
    """音频长度是否触顶（≈ max_len 个 speech token）。保留作硬上限兜底。"""
    return max_len > 0 and samples >= (max_len - 1) * 960


def _zero_shot_cached(model, text, prompt_text, wav_path, speed):
    """等价于 model.inference_zero_shot(...)，但复用参考音特征（产出 list）。"""
    fe = model.frontend
    base = _prompt_input_cached(model, wav_path, prompt_text)
    try:
        retry_cap = int(_MAX_RETRY)
    except ValueError:
        retry_cap = 2
    ratio = _max_token_ratio()
    sr = float(getattr(model, "sample_rate", None) or 24000)
    outs = []
    # 与官方一致：prompt_text 先 normalize（注意它含 [token] ⇒ text_normalize 直接
    # 原样返回，所以这里不重复调用，只在 _prompt_input_cached 里传原文即可）。
    for i in fe.text_normalize(text, split=True, text_frontend=True):
        tts_text_token, tts_text_token_len = fe._extract_text_token(i)
        n_text = int(tts_text_token_len.item())
        max_len = int(n_text * ratio)
        # 期望时长由自然语速反推；speed>1 说得更快 ⇒ 时长按 1/speed 缩放。
        expect = n_text * _SEC_PER_TEXT_TOKEN / (speed if speed and speed > 0 else 1.0)
        lo, hi = expect * _DUR_MIN_FACTOR, expect * _DUR_MAX_FACTOR
        best = None   # (排序键, 段结果)；键 = (是否可接受, 与期望的偏差)
        for attempt in range(retry_cap + 1):
            model_input = dict(base)
            model_input["text"] = tts_text_token
            model_input["text_len"] = tts_text_token_len
            seg = list(model.model.tts(**model_input, stream=False, speed=speed))
            n_samples = sum(o["tts_speech"].shape[1] for o in seg)
            dur = n_samples / sr
            hit_cap = _truncated(n_samples, max_len)
            ok = (not hit_cap) and (lo <= dur <= hi)
            # ── 排序键：正确性优先于"接近期望" ───────────────────────────
            # 2026-10-25 实测教训（tools-dev/sweep-rep11.log）：21 字句 3 次尝试全失败时，
            # 初版按 `abs(dur-expect)` 选最近的 ⇒ 选中 **1.80 s（缺字）** 而非 8.76 s（复读）。
            # 对 TTS 来说这两类错误的代价**不对称**：
            #   · 过长/复读 ⇒ 听着啰嗦，但**每个字都在**（可懂）；
            #   · 过短/缺字 ⇒ **字丢了**，意思可能反转（不可接受）。
            # ⇒ 分级：正常(0) < 偏长(1) < 撞满上限(2) < 偏短(3)。
            #    仅在**同级内**才用"离期望更近"做次级排序。
            if ok:
                tier = 0
            elif hit_cap:
                # 撞满上限被硬切：话基本说完了，只是拖长/复读 ⇒ 次优。
                # ⚠️ 这一支必须**先于** dur>hi 判断：初版把 hit_cap 只写进
                #    `dur > hi` 分支，导致「撞顶但时长仍在 lo~hi 内」的样本
                #    （如 3 字 1.44 s）跌进 else 被当成 tier=3「太短」，
                #    和真正缺字的 0.28 s 同级 ⇒ 次级排序按"离期望更近"把
                #    0.28 s 选中（实测 sweep-ratio12.log 的 bad 样本）。
                tier = 1
            elif dur > hi:
                tier = 2            # 偏长但自然收尾
            else:
                tier = 3            # 太短 = 缺字，最不可接受
            key = (tier, abs(dur - expect))
            if best is None or key < best[0]:
                best = (key, seg)
            if ok:
                break
            # ── 撞顶（跑满 max_len）**不再重试**（2026-10-25）──────────────
            # 撞顶 = LLM 一路到 max_len 都没发 EOS，单次 wall 就是
            # `max_len × 40 ms`（21 字 ⇒ 420 帧 ⇒ 16.8 s）。tier=1 的产物
            # 本身是「话基本说完了，只是拖长」（可懂）；再跑一次不是「修正」
            # 而是再赌一次运气，代价是又一份最长 wall —— 用户等待直接翻倍。
            # 实测依据：21 字句多次 sweep 里两次都是精确 16.80 s 撞顶，重试
            # 那次也没有更接近自然时长（≈3~4 s）。
            # 对照开关：COSYVOICE_RETRY_ON_CAP=1 恢复旧行为（撞顶仍重试）。
            if hit_cap and os.environ.get("COSYVOICE_RETRY_ON_CAP", "0") != "1":
                print(f'[cosyvoice] 撞顶不重试 (text_tokens={n_text} dur={dur:.2f}s '
                      f'cap={max_len} 帧)', flush=True)
                break
            if attempt < retry_cap:
                print(f'[cosyvoice] 时长异常重试 {attempt + 1}/{retry_cap} '
                      f'(text_tokens={n_text} dur={dur:.2f}s expect={expect:.2f}s '
                      f'ok={lo:.2f}~{hi:.2f}s cap_hit={hit_cap})', flush=True)
        if best is not None:
            outs.extend(best[1])
    return outs


def synthesize(text: str, voice: str = "", speed: float = 1.0) -> bytes:
    """文本 → WAV 字节。

    音色路径（voice 参数选择参考音）：
      1. 音色对存在（voices/<voice>.wav + .txt）→ zero-shot 克隆该音色；
      2. **未显式指定**音色且 voices/default.* 缺失 → 回退目录里第一个可用音色，
         并打一行日志（新装机 / 配置重置后的常态；以前这里直接 500）；
      3. **显式指定**的音色不存在 → 报错（明确告知，不静默换音色 —— 用户听得
         出差别）；
      4. 一个音色都没有 → inference_sft（需 spk2info，基础模型没有）→ 明确报错。
    speed：inference_* 原生参数（0.5~2），透传官方实现。
    """
    model = load_model()
    want = voice or "default"
    explicit = bool(voice)
    with _LOCK:   # CosyVoice 推理非线程安全，串行化
        # 注意：inference_zero_shot 的 prompt_wav 参数**必须是文件路径** ——
        # frontend._extract_speech_feat 内部 load_wav(path) 自己加载/重采样
        # （传 tensor 会一路透传到 soundfile → "Invalid file: tensor(...)"）。
        pair = _voice_pair(want)
        if pair is None and not explicit:
            fb = _first_voice_pair()
            if fb:
                print(f'[cosyvoice] voices/default.* 缺失 → 回退首个可用音色 "{fb[0]}"', flush=True)
                pair = (fb[1], fb[2])
        if pair:
            wav_path, txt_path = pair
            # v3 协议：参考音文字稿须以 [token] 结尾（llm 在此切分 prompt）
            prompt_text = open(txt_path, "r", encoding="utf-8").read().strip() + "<|endofprompt|>"
            if _PROMPT_CACHE_ON:
                outs = _zero_shot_cached(model, text, prompt_text, wav_path, speed)
            else:
                outs = model.inference_zero_shot(text, prompt_text, wav_path, stream=False, speed=speed)
            return _to_wav(outs, model.sample_rate)

        if explicit:
            raise RuntimeError(f"音色不存在：{want}（需要 {_ARGS.voices_dir or 'voices'}/{want}.wav + {want}.txt）")

        # ── 一个音色都没有：sft 内置（有 spk2info 才可用）→ 明确报错 ──
        if getattr(model.frontend, "spk2info", None):
            try:
                return _to_wav(model.inference_sft(text, "中文女", stream=False, speed=speed), model.sample_rate)
            except Exception as e:
                print(f"[cosyvoice] inference_sft unavailable ({e}); falling back to zero-shot", flush=True)
        raise RuntimeError(
            f"默认音色缺少参考音频：请放置 {_ARGS.voices_dir or '<models.root>/voices'}/default.wav 与该音频的逐字文字稿 default.txt"
        )


def _to_wav(results, sample_rate: int = 24000, gap_s: float = 0.08):
    """把 tts 产出的**全部分段**拼成单个 PCM16 WAV。

    ⚠️ 旧版只取 next(results) ⇒ 超过 text_normalize 分句阈值（token_max_n=80，
    中文约 80 字）的长文本会被**静默截断，只读出第一段**。长回复丢尾是听感上
    最恶劣的一类 bug（用户以为模型只说了一半），这里改成全部拼接，段间留
    gap_s 静音避免切开的两句粘字。
    """
    import torch
    import torchaudio
    chunks = [r["tts_speech"] for r in results]
    if not chunks:
        raise RuntimeError("tts 未产出音频")
    if len(chunks) == 1:
        wav = chunks[0]
    else:
        gap = torch.zeros(1, int(sample_rate * gap_s), dtype=chunks[0].dtype, device=chunks[0].device)
        parts = []
        for i, c in enumerate(chunks):
            if i:
                parts.append(gap)
            parts.append(c)
        wav = torch.cat(parts, dim=1)
    buf = io.BytesIO()
    # PCM16 WAV：torchaudio 默认写 float32（部分播放器/解码器不认 fmt=3）
    torchaudio.save(buf, wav, sample_rate, format="wav", encoding="PCM_S", bits_per_sample=16)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            # 模型加载完成前 /health 返回 503 —— Node 侧据此等待就绪
            ok = _MODEL is not None
            self.send_response(200 if ok else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ready": %s}' % (b"true" if ok else b"false"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        import json
        body = json.loads(self.rfile.read(length) or b"{}")
        text = (body.get("text") or "").strip()
        voice = (body.get("voice") or "").strip()
        try:
            speed = float(body.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = max(0.5, min(2.0, speed))
        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"empty text")
            return
        # variant 由服务启动参数决定（换 base/rl = 重启服务，Node 侧管理）
        try:
            wav = synthesize(text, voice, speed)
        except Exception as e:
            # 完整 traceback 打到 stdout（Node 侧收进日志）。只回一行 str(e) 时挂死点
            # 无从定位 —— 2026-10-25 实况：六个不同长度用例返回同一句
            # "padded input size per channel: (3), kernel size: (4)"，光看这行根本
            # 分不清是文本侧（text_encoder）还是参考音侧（flow/hift）短了。
            import traceback
            print(f"[cosyvoice] tts failed ({len(text)} chars, voice={voice or '-'}): {e}", flush=True)
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8"))
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, fmt, *args):   # 静默默认访问日志（Node 侧已收 stdout/stderr）
        pass


class _ExclusiveHTTPServer(ThreadingHTTPServer):
    """独占绑定端口的 HTTP 服务。

    为什么不用默认的 ThreadingHTTPServer：它 `allow_reuse_address = True`，
    在 Windows 上等于 SO_REUSEADDR —— 允许**两个进程同时绑定同一端口**（后绑者抢占），
    于是重复实例既不报错也不退出，只是把连接搅乱。2026-10-25 实况：两个后端进程
    （webui :3199 与 :3130 各持一份 CosyVoiceService 单例）各拉起一个 server.py，
    两个都"绑上了"，显存被吃到 7934/8188 MiB，其中一个完全是废物。
    改用 SO_EXCLUSIVEADDRUSE ⇒ 第二个实例 bind 立即失败、进程秒退、零显存代价。
    """

    allow_reuse_address = False

    def server_bind(self):
        if sys.platform == "win32":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    global _ARGS
    parser = argparse.ArgumentParser(description="CosyVoice3 local inference server (hyacinth)")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--variant", choices=["base", "rl"], default="rl")
    parser.add_argument("--voices-dir", default="", help="参考音目录（<models.root>/voices，与模型权重解耦）")
    parser.add_argument("--port", type=int, default=3178)
    _ARGS = parser.parse_args()

    # 顺序不可倒：**先 bind、后加载模型**。
    # 旧版是「先起线程 load_model() 再 bind」⇒ 重复实例要先把 ~4 GB 权重灌进显存，
    # 才在 bind 那一步发现端口被占（而且旧版还抢得住，见 _ExclusiveHTTPServer）。
    # 端口拿不到就没必要加载模型。
    try:
        server = _ExclusiveHTTPServer(("127.0.0.1", _ARGS.port), Handler)
    except OSError as e:
        print(f"[cosyvoice] port {_ARGS.port} unavailable ({e}); exiting", file=sys.stderr, flush=True)
        sys.exit(2)
    print(f"[cosyvoice] listening on 127.0.0.1:{_ARGS.port}", flush=True)

    # 模型在后台线程加载：/health 在就绪前返回 503（Node 侧据此等待）
    threading.Thread(target=load_model, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
