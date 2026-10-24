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
        _MODEL = CosyVoice3(_ARGS.model_dir, load_trt=False, fp16=False)
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


def synthesize(text: str, voice: str = "", speed: float = 1.0) -> bytes:
    """文本 → WAV 字节。

    音色路径（voice 参数选择参考音）：
      1. 音色对存在（voices/<voice>.wav + .txt）→ zero-shot 克隆该音色；
      2. 指定音色但不存在 → 报错（明确告知，不静默换音色 —— 用户听得出差别）；
      3. 默认音色无参考音 → inference_sft（需要 spk2info.pt，基础模型没有则跳过）
         → 明确报错（提示放 voices/default.wav）。
    speed：inference_* 原生参数（0.5~2），透传官方实现。
    """
    model = load_model()
    want = voice or "default"
    with _LOCK:   # CosyVoice 推理非线程安全，串行化
        # 注意：inference_zero_shot 的 prompt_wav 参数**必须是文件路径** ——
        # frontend._extract_speech_feat 内部 load_wav(path) 自己加载/重采样
        # （传 tensor 会一路透传到 soundfile → "Invalid file: tensor(...)"）。
        pair = _voice_pair(want)
        if pair:
            wav_path, txt_path = pair
            prompt_text = open(txt_path, "r", encoding="utf-8").read().strip() + "<|endofprompt|>"  # v3 协议：参考音文字稿须以此特殊 token 结尾（llm 在此切分 prompt）
            results = model.inference_zero_shot(text, prompt_text, wav_path, stream=False, speed=speed)
            return _to_wav(results)

        if want != "default":
            raise RuntimeError(f"音色不存在：{want}（需要 {_ARGS.voices_dir or 'voices'}/{want}.wav + {want}.txt）")

        # ── 默认音色无参考音：sft 内置（有 spk2info 才可用）→ 明确报错 ──
        if getattr(model.frontend, "spk2info", None):
            try:
                results = model.inference_sft(text, "中文女", stream=False, speed=speed)
                return _to_wav(results)
            except Exception as e:
                print(f"[cosyvoice] inference_sft unavailable ({e}); falling back to zero-shot", flush=True)
        raise RuntimeError(
            f"默认音色缺少参考音频：请放置 {_ARGS.voices_dir or '<models.root>/voices'}/default.wav 与该音频的逐字文字稿 default.txt"
        )


def _to_wav(results):
    wav_bytes = next(results)["tts_speech"]           # torch tensor [1, N]
    import torchaudio
    buf = io.BytesIO()
    # PCM16 WAV：torchaudio 默认写 float32（部分播放器/解码器不认 fmt=3）
    torchaudio.save(buf, wav_bytes, 24000, format="wav", encoding="PCM_S", bits_per_sample=16)
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


def main():
    global _ARGS
    parser = argparse.ArgumentParser(description="CosyVoice3 local inference server (hyacinth)")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--variant", choices=["base", "rl"], default="rl")
    parser.add_argument("--voices-dir", default="", help="参考音目录（<models.root>/voices，与模型权重解耦）")
    parser.add_argument("--port", type=int, default=3178)
    _ARGS = parser.parse_args()

    # 模型在后台线程预加载：/health 先行可探测（Node 轮询就绪）
    threading.Thread(target=load_model, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", _ARGS.port), Handler)
    print(f"[cosyvoice] listening on 127.0.0.1:{_ARGS.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
