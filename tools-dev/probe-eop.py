import sys, subprocess
sys.path.insert(0, r"C:\Users\74689\.agent\envs\CosyVoice")

SERVER = r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py"

def codes(s):
    return " ".join(str(ord(c)) for c in s)

def show_line(path_or_text, label, is_text=False):
    txt = path_or_text if is_text else open(path_or_text, encoding="utf-8").read()
    for i, ln in enumerate(txt.split("\n"), 1):
        if "prompt_text" in ln and "+" in ln:
            print(f"[{label}:{i}] {codes(ln.strip())}")
            print(f"     printable: {ln.strip()!r}"[:400])

print("############ A. 当前 server.py 里的 prompt_text 拼接 ############")
show_line(SERVER, "HEAD")

print()
print("############ B. git 版本对照 ############")
for rev in ["07b3c47", "814b67d", "HEAD"]:
    try:
        out = subprocess.run(
            ["git", "show", f"{rev}:src/tts/engines/cosyvoice/server.py"],
            cwd=r"C:\Users\74689\Desktop\Agent\hyacinth",
            capture_output=True, text=True, encoding="utf-8",
        )
        if out.returncode != 0:
            print(f"[{rev}] git err: {out.stderr.strip()[:200]}")
            continue
        hits = [ln for ln in out.stdout.split("\n") if "prompt_text" in ln and "read()" in ln]
        for h in hits:
            print(f"[{rev}] {codes(h.strip())}")
    except Exception as e:
        print(f"[{rev}] ERR {type(e).__name__} {e}")

print()
print("############ C. CosyVoice3Tokenizer 实际编码 <|endofprompt|> ############")
try:
    from cosyvoice.tokenizer.tokenizer import get_qwen_tokenizer
    D = r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN"
    for ver in ["cosyvoice3", "cosyvoice2"]:
        try:
            tk = get_qwen_tokenizer(D, False, ver)
            print(f"  version={ver} class={type(tk).__name__} len={len(tk)}")
            eop = chr(60) + "|endofprompt|" + chr(62)
            for label, s in [("eop alone", eop), ("prompt+eop", "Really, I promise." + eop), ("zh", "你好，孑遗。")]:
                try:
                    ids = tk.encode(s, allowed_special="all")
                    print(f"    {label}: has151646={151646 in ids} ids={ids[:6]}{'...' if len(ids) > 6 else ''}")
                except Exception as e2:
                    print(f"    {label}: ERR {type(e2).__name__} {e2}")
        except Exception as e1:
            print(f"  version={ver} ERR {type(e1).__name__} {e1}")
except Exception as e:
    print("  import ERR", type(e).__name__, e)

print()
print("############ D. cli/cosyvoice.py 里 CosyVoice3 如何建 tokenizer ############")
p = r"C:\Users\74689\.agent\envs\CosyVoice\cosyvoice\cli\cosyvoice.py"
lines = open(p, encoding="utf-8").read().split("\n")
for i, ln in enumerate(lines, 1):
    if "get_tokenizer" in ln or "version=" in ln or "class CosyVoice3" in ln:
        print(f"  {i}: {ln.strip()}")
