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


def _patch_token_ratio():
    """生成长度约束可调（2026-10-25 实测发现「合成时长不可控」后加）。

    上游 `cosyvoice/llm/llm.py` 的 Qwen2LM.inference 里有：
        min_len = 文本token数 * min_token_text_ratio   # 默认 2
        max_len = 文本token数 * max_token_text_ratio   # 默认 20
    模型只能在 [2N, 20N] 个 speech token 之间随机停（1 token ≈ 40 ms 音频）。
    默认 20 相当于允许「每个字说 0.8 秒」（正常中文 ≈ 0.25 s/字 ≈ 6 token），
    太宽 ⇒ 同一句话连测三次能给出 0.32 / 0.72 / 4.80 秒，差 15 倍。
    更严重的是短文本（3 字）时 min_len 太小，模型秒吐 EOS，flow 卷积核
    比输入还长 ⇒ HTTP 500「Kernel size (4) can't be greater than actual input size」。

    这里用环境变量覆盖，**不改第三方仓库源码**（升级不丢）：
        COSYVOICE_MAX_TOKEN_RATIO / COSYVOICE_MIN_TOKEN_RATIO
    不设 = 保持上游默认，行为零变化。
    """
    max_r = os.environ.get('COSYVOICE_MAX_TOKEN_RATIO')
    min_r = os.environ.get('COSYVOICE_MIN_TOKEN_RATIO')
    if not max_r and not min_r:
        return
    try:
        from cosyvoice.llm import llm as _llm
    except Exception as e:  # noqa: BLE001 — patch 失败不该阻断服务
        print(f'[cosyvoice] token-ratio patch skipped: {e}', flush=True)
        return
    overrides = {}
    if max_r:
        overrides['max_token_text_ratio'] = float(max_r)
    if min_r:
        overrides['min_token_text_ratio'] = float(min_r)

    import functools
    orig = _llm.Qwen2LM.inference

    @functools.wraps(orig)
    def patched(self, *args, **kwargs):
        for k, v in overrides.items():
            kwargs.setdefault(k, v)
        return orig(self, *args, **kwargs)

    _llm.Qwen2LM.inference = patched
    print(f'[cosyvoice] token-ratio patched: {overrides}', flush=True)


def load_model():
    """加载 CosyVoice3（选择 base / rl 的 LLM 权重）。"""
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    from cosyvoice.cli.cosyvoice import CosyVoice3  # 官方生态

    _patch_wetext_offline()
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


def _zero_shot_cached(model, text, prompt_text, wav_path, speed):
    """等价于 model.inference_zero_shot(...)，但复用参考音特征（产出 list）。"""
    fe = model.frontend
    base = _prompt_input_cached(model, wav_path, prompt_text)
    outs = []
    # 与官方一致：prompt_text 先 normalize（注意它含 [token] ⇒ text_normalize 直接
    # 原样返回，所以这里不重复调用，只在 _prompt_input_cached 里传原文即可）。
    for i in fe.text_normalize(text, split=True, text_frontend=True):
        tts_text_token, tts_text_token_len = fe._extract_text_token(i)
        model_input = dict(base)
        model_input["text"] = tts_text_token
        model_input["text_len"] = tts_text_token_len
        outs.extend(model.model.tts(**model_input, stream=False, speed=speed))
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
            prompt_text = open(txt_path, "r", encoding="utf-8").read().strip() + "[token]"
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
