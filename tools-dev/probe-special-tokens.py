import os, sys, json, inspect
sys.path.insert(0, r"C:\Users\74689\.agent\envs\CosyVoice")
LT, GT = chr(60), chr(62)   # < >

def seg_codes(s):
    return " ".join(str(ord(c)) for c in s)

def scan(path, label):
    try:
        txt = open(path, encoding="utf-8").read()
    except Exception as e:
        print(f"[ERR] {label}: {e}"); return
    for i, ln in enumerate(txt.split("\n"), 1):
        j = ln.find(LT + "|")
        if j < 0:
            continue
        k = ln.find(GT, j + 2)
        if k < 0:
            continue
        seg = ln[j:k + 1]
        print(f"[{label}:{i}] token_codes=({seg_codes(seg)}) len={len(seg)}")
        print(f"    context_codes=({seg_codes(ln.strip())})")

print("############ 1. 源码里的特殊 token 字面量 ############")
scan(r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py", "server.py")
scan(r"C:\Users\74689\.agent\envs\CosyVoice\cosyvoice\cli\frontend.py", "frontend.py")
scan(r"C:\Users\74689\.agent\envs\CosyVoice\cosyvoice\llm\llm.py", "llm.py")
scan(r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN\tokenizer_config.json", "tokcfg")

print()
print("############ 2. tokenizer_config.json added_tokens 键值 ############")
cfg = json.load(open(r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN\tokenizer_config.json", encoding="utf-8"))
for k, v in cfg.get("added_tokens_decoder", {}).items():
    print(f"  id={k} content_codes=({seg_codes(v.get('content',''))})")
print("  additional_special_tokens:", [seg_codes(t) for t in cfg.get("additional_special_tokens", [])])
print("  eos/pad/bos:", seg_codes(str(cfg.get("eos_token"))), seg_codes(str(cfg.get("pad_token"))))

print()
print("############ 3. 真实 tokenizer 行为 ############")
from transformers import AutoTokenizer
D = r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN"
tk = AutoTokenizer.from_pretrained(D)
print("  len(tk) =", len(tk), " vocab_size =", tk.vocab_size)
for i in [151643, 151644, 151645, 151646, 151647]:
    try:
        t = tk.convert_ids_to_tokens(i)
        print(f"  id {i} -> codes=({seg_codes(str(t))})")
    except Exception as e:
        print(f"  id {i} ERR {e}")

print()
print("############ 4. CosyVoice3Tokenizer 是否注入 151646 ############")
try:
    from cosyvoice.tokenizer.tokenizer import CosyVoice3Tokenizer, CosyVoice2Tokenizer
    src = inspect.getsource(CosyVoice3Tokenizer)
    print("---- CosyVoice3Tokenizer source ----")
    print(src)
except Exception as e:
    print("ERR", type(e).__name__, e)

print()
print("############ 5. cosyvoice3.yaml 里 token 相关配置 ############")
for ln in open(r"C:\Users\74689\.agent\models\tts\cosyvoice3\cosyvoice3.yaml", encoding="utf-8"):
    low = ln.lower()
    if "token" in low and ("path" in low or "special" in low or "version" in low):
        print("  " + ln.rstrip())
