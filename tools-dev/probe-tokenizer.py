import sys, re
sys.path.insert(0, r"C:\Users\74689\.agent\envs\CosyVoice")
D = r"C:\Users\74689\.agent\models\tts\cosyvoice3\CosyVoice-BlankEN"

print("=== yaml get_tokenizer ===")
for line in open(r"C:\Users\74689\.agent\models\tts\cosyvoice3\cosyvoice3.yaml", encoding="utf-8"):
    if "tokenizer" in line.lower() or "allowed_special" in line:
        print("  " + line.rstrip())

print("\n=== Qwen2 AutoTokenizer ===")
from transformers import AutoTokenizer
tk = AutoTokenizer.from_pretrained(D)
print("class:", type(tk).__name__)
print("convert [token] ->", tk.convert_tokens_to_ids("[token]"))
ids = tk.encode("Really, I promise.[token]")
print("encode has 151646:", 151646 in ids, "| has 151643:", 151643 in ids, "| ids tail:", ids[-4:])
try:
    t2 = sys.path.insert(0, r"C:\Users\74689\.agent\envs\CosyVoice")
    from cosyvoice.tokenizer.tokenizer import get_encoding
    enc = get_encoding("multilingual_zh_ja_yue_char_del", 99)
    print("\n=== tiktoken get_encoding ===")
    print("n_vocab:", enc.n_vocab)
    for s in ["[token]"]:
        print(repr(s), "->", enc.encode(s, allowed_special="all"))
except Exception as e:
    print("tiktoken probe skip:", type(e).__name__, e)
