import re, sys, io
sys.path.insert(0, r"C:\Users\74689\.agent\envs\CosyVoice")

P = r"C:\Users\74689\Desktop\Agent\hyacinth\src\tts\engines\cosyvoice\server.py"
EOP  = chr(60) + "|endofprompt|" + chr(62)    # <|endofprompt|>
SQBR = "[" + "token" + "]"                    # [token]

raw = open(P, "rb").read()
print("CRLF count:", raw.count(b"\r\n"), "| lone LF:", raw.count(b"\n") - raw.count(b"\r\n"))
t = raw.decode("utf-8")

print("before: eop-literal =", t.count('"' + EOP + '"'), "| sqbr-literal =", t.count('"' + SQBR + '"'))

pat = re.compile(r'(prompt_text = open\(txt_path[^\n]*?\.strip\(\) \+ )"[^"]*"')
t2, n = pat.subn(lambda m: m.group(1) + '"' + EOP + '"', t)
print("regex replacements:", n)
if n != 1:
    print("ABORT: expected exactly 1 replacement"); sys.exit(1)

open(P, "wb").write(t2.encode("utf-8"))

# 写后自检：重读断言
t3 = open(P, "rb").read().decode("utf-8")
ok_eop = t3.count('"' + EOP + '"')
ok_sqbr = t3.count('"' + SQBR + '"')
print("after : eop-literal =", ok_eop, "| sqbr-literal =", ok_sqbr)
assert ok_eop == 1 and ok_sqbr == 0, "self-check FAILED"

for i, ln in enumerate(t3.split("\n"), 1):
    if "prompt_text = open(txt_path" in ln:
        print(f"[line {i}] codes:", " ".join(str(ord(c)) for c in ln.strip()))

print("\n=== py_compile ===")
import py_compile
try:
    py_compile.compile(P, doraise=True)
    print("py_compile OK")
except Exception as e:
    print("py_compile FAILED:", e); sys.exit(1)

print("\n=== tokenizer 交叉验证 ===")
try:
    from cosyvoice.tokenizer.tokenizer import get_qwen_tokenizer
    D = r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN"
    tk = get_qwen_tokenizer(D, False, "cosyvoice3")
    for label, s in [("eop alone", EOP), ("prompt+eop", "Really, I promise." + EOP), ("sqbr", SQBR)]:
        ids = tk.encode(s, allowed_special="all")
        print(f"  {label}: has151646={151646 in ids} ids={ids[:8]}")
except Exception as e:
    print("  ERR", type(e).__name__, e)
