#!/usr/bin/env python3
"""
hyacinth 训练基础设施管理 CLI

管理功能：数据库初始化、Session 导入、数据清洗、LoRA 数据集构建与导出。

数据库默认存放在 ~/.agent/training.db（用户数据目录）。
首次使用先执行 `manage.py init` 创建。
"""

import json
import sqlite3
import argparse
import os
import shutil
from datetime import datetime

# ── 路径 ──────────────────────────────────────────────
# manage.py 所在包目录（随 hyacinth 安装）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(SCRIPT_DIR)                     # training/
HYACINTH_SRC = os.path.dirname(PKG_DIR)                   # agent/

# 用户数据目录（同 hyacinth 其他配置）
USER_DIR = os.path.expanduser("~/.agent")

# 默认数据库路径（用户数据目录）
DEFAULT_DB = os.path.join(USER_DIR, "training.db")

# 数据库模板（包内空库，仅含 schema）
TEMPLATE_DB = os.path.join(PKG_DIR, "training.db")

# 模型仓库（包内，仅注册表配置，无模型文件）
MODEL_REPO = os.path.join(HYACINTH_SRC, "model-repo")
BASE_MODELS_DIR = os.path.join(MODEL_REPO, "base_models")
LORAS_DIR = os.path.join(MODEL_REPO, "loras")
REPO_REGISTRY = os.path.join(MODEL_REPO, "registry.json")
BASE_REGISTRY = os.path.join(BASE_MODELS_DIR, "registry.json")
LORA_REGISTRY = os.path.join(LORAS_DIR, "registry.json")

# ── 数据库初始化 ───────────────────────────────────────
def cmd_init():
    """在 ~/.agent/ 下创建 training.db（如果不存在）"""
    os.makedirs(USER_DIR, exist_ok=True)

    if os.path.isfile(DEFAULT_DB):
        print(f"⚠️  数据库已存在: {DEFAULT_DB}")
        return

    # 从模板复制
    if os.path.isfile(TEMPLATE_DB):
        shutil.copy2(TEMPLATE_DB, DEFAULT_DB)
        print(f"✅ 数据库已创建: {DEFAULT_DB}")
    else:
        # 模板不存在则从 schema.sql 新建
        schema_path = os.path.join(PKG_DIR, "schema.sql")
        if os.path.isfile(schema_path):
            conn = sqlite3.connect(DEFAULT_DB)
            with open(schema_path, 'r', encoding='utf-8') as f:
                conn.executescript(f.read())
            conn.close()
            print(f"✅ 数据库已创建 (从 schema.sql): {DEFAULT_DB}")
        else:
            print("❌ schema.sql 和 training.db 模板都不存在，无法初始化")
            return

    # 初始化模型仓库注册表（如果为空）
    for reg_path in [BASE_REGISTRY, LORA_REGISTRY]:
        if os.path.isfile(reg_path):
            reg = json.load(open(reg_path, 'r', encoding='utf-8'))
            if not reg.get('models') and not reg.get('loras'):
                pass  # 空注册表正常

    print(f"💡 使用: python manage.py stats   # 查看统计")
    print(f"💡 使用: python manage.py import-sessions   # 导入对话数据")

# ── DB 连接 ───────────────────────────────────────────
def get_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

# ── 统计 ──────────────────────────────────────────────
def cmd_stats(db_path):
    if not os.path.isfile(db_path):
        print(f"❌ 数据库不存在: {db_path}")
        print(f"   请先运行: python manage.py init")
        return

    conn = get_db(db_path)
    cur = conn.cursor()

    cur.execute("SELECT count(*) FROM raw_sessions")
    raw_count = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM raw_sessions WHERE status='done'")
    done_count = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM cleaned_samples")
    clean_count = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM sample_capabilities")
    cap_count = cur.fetchone()[0]
    cur.execute("SELECT capability, count(*) as cnt FROM sample_capabilities GROUP BY capability ORDER BY cnt DESC")
    caps = cur.fetchall()
    cur.execute("SELECT count(*) FROM lora_datasets")
    lora_count = cur.fetchone()[0]
    cur.execute("SELECT status, count(*) as cnt FROM lora_datasets GROUP BY status")
    lora_statuses = cur.fetchall()

    conn.close()

    print(f"\n{'='*50}")
    print(f"  🪴 hyacinth — 训练数据库统计")
    print(f"{'='*50}")
    print(f"  📁 {db_path}")
    print()
    print(f"  📦 原始 Session:     {raw_count:>5}")
    print(f"  ✅ 已处理 Session:   {done_count:>5}")
    print(f"  🧹 清洗后样本:       {clean_count:>5}")
    print(f"  🏷️  功能标签数:       {cap_count:>5}")
    if caps:
        print(f"\n  📊 标签分布:")
        for c in caps:
            print(f"    {c['capability']:15s}  {c['cnt']:>5}")
    print(f"\n  🧠 LoRA 数据集:      {lora_count:>5}")
    for s in lora_statuses:
        print(f"    [{s['status']:8s}]  {s['cnt']:>5}")
    print(f"{'='*50}\n")

# ── 注册底模 ──────────────────────────────────────────
def cmd_register_model(name, model_type, path, params):
    registry = json.load(open(BASE_REGISTRY, 'r', encoding='utf-8'))
    entry = {
        "name": name,
        "type": model_type,
        "path": path,
        "params": params or {},
        "registered_at": datetime.now().isoformat()
    }
    registry['models'] = [m for m in registry['models'] if m['name'] != name]
    registry['models'].append(entry)
    registry['updated_at'] = datetime.now().isoformat()
    json.dump(registry, open(BASE_REGISTRY, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    top = json.load(open(REPO_REGISTRY, 'r', encoding='utf-8'))
    top['base_models'][name] = entry
    top['updated_at'] = datetime.now().isoformat()
    json.dump(top, open(REPO_REGISTRY, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    print(f"✅ 底模 '{name}' 已注册")

def cmd_list_models():
    registry = json.load(open(BASE_REGISTRY, 'r', encoding='utf-8'))
    models = registry['models']
    if not models:
        print("  暂无注册的底模")
        return
    print(f"\n{'='*50}")
    print(f"  已注册底模 ({len(models)})")
    print(f"{'='*50}")
    for m in models:
        print(f"  📦 {m['name']:30s}  {m['type']:10s}  {m.get('path','')}")

# ── LoRA 管理 ─────────────────────────────────────────
def cmd_create_lora(db_path, lora_id, base_model, description, capability_filter, params):
    conn = get_db(db_path)
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO lora_datasets
        (lora_id, base_model, description, capability_filter, params, status)
        VALUES (?, ?, ?, ?, ?, 'draft')
    """, (lora_id, base_model, description,
          json.dumps(capability_filter) if capability_filter else None,
          json.dumps(params) if params else None))
    conn.commit()
    conn.close()

    lora_reg = json.load(open(LORA_REGISTRY, 'r', encoding='utf-8'))
    entry = {
        "lora_id": lora_id,
        "base_model": base_model,
        "description": description,
        "status": "draft",
        "created_at": datetime.now().isoformat()
    }
    lora_reg['loras'] = [l for l in lora_reg['loras'] if l['lora_id'] != lora_id]
    lora_reg['loras'].append(entry)
    lora_reg['updated_at'] = datetime.now().isoformat()
    json.dump(lora_reg, open(LORA_REGISTRY, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    print(f"✅ LoRA 数据集 '{lora_id}' 已创建 (draft)")

def cmd_list_loras(db_path):
    if not os.path.isfile(db_path):
        print("❌ 数据库不存在，请先运行 init")
        return
    conn = get_db(db_path)
    cur = conn.cursor()
    cur.execute("""
        SELECT lora_id, base_model, description, status, train_count, val_count, updated_at
        FROM lora_datasets ORDER BY updated_at DESC
    """)
    rows = cur.fetchall()
    conn.close()

    if not rows:
        print("  暂无 LoRA 数据集")
        return
    print(f"\n{'='*60}")
    print(f"  🧠 LoRA 数据集列表")
    print(f"{'='*60}")
    for r in rows:
        print(f"  {r['lora_id']:20s}  [{r['status']:8s}]  base: {r['base_model']:20s}  "
              f"train:{r['train_count']} val:{r['val_count']}")
        if r['description']:
            print(f"     {r['description']}")

def cmd_build_dataset(db_path, lora_id, split_ratio=0.9):
    conn = get_db(db_path)
    cur = conn.cursor()

    cur.execute("SELECT * FROM lora_datasets WHERE lora_id = ?", (lora_id,))
    lora = cur.fetchone()
    if not lora:
        print(f"❌ LoRA '{lora_id}' 不存在")
        conn.close()
        return

    cf = json.loads(lora['capability_filter']) if lora['capability_filter'] else {}

    if 'capability' in cf:
        cur.execute("""
            SELECT cs.* FROM cleaned_samples cs
            JOIN sample_capabilities sc ON sc.sample_id = cs.id
            WHERE sc.capability = ? AND cs.quality_score >= ?
            ORDER BY cs.created_at
        """, (cf['capability'], cf.get('min_quality', 0.0)))
    else:
        cur.execute("""
            SELECT * FROM cleaned_samples
            WHERE quality_score >= ?
            ORDER BY created_at
        """, (cf.get('min_quality', 0.0),))

    samples = cur.fetchall()
    if not samples:
        print(f"⚠️  没有符合条件的样本")
        conn.close()
        return

    total = len(samples)
    split_idx = int(total * split_ratio)
    train = samples[:split_idx]
    val = samples[split_idx:]

    cur.execute("DELETE FROM lora_sample_map WHERE lora_id = ?", (lora_id,))
    for s in train:
        cur.execute("INSERT OR IGNORE INTO lora_sample_map (lora_id, sample_id, split) VALUES (?, ?, 'train')",
                    (lora_id, s['id']))
    for s in val:
        cur.execute("INSERT OR IGNORE INTO lora_sample_map (lora_id, sample_id, split) VALUES (?, ?, 'val')",
                    (lora_id, s['id']))

    cur.execute("""UPDATE lora_datasets SET
        train_count = ?, val_count = ?, status = 'ready', updated_at = datetime('now')
        WHERE lora_id = ?
    """, (len(train), len(val), lora_id))
    conn.commit()
    conn.close()

    print(f"✅ LoRA '{lora_id}' 数据集构建完成")
    print(f"   train: {len(train)}  |  val: {len(val)}  |  总数: {total}")

def cmd_export_dataset(db_path, lora_id, output_dir):
    conn = get_db(db_path)
    cur = conn.cursor()
    os.makedirs(output_dir, exist_ok=True)

    for split_name in ['train', 'val']:
        cur.execute("""
            SELECT cs.messages FROM cleaned_samples cs
            JOIN lora_sample_map lm ON lm.sample_id = cs.id
            WHERE lm.lora_id = ? AND lm.split = ?
        """, (lora_id, split_name))
        samples = cur.fetchall()

        if not samples:
            print(f"  ⚠️  {split_name}: 无数据")
            continue

        out_path = os.path.join(output_dir, f"{lora_id}_{split_name}.jsonl")
        with open(out_path, 'w', encoding='utf-8') as f:
            for s in samples:
                f.write(s['messages'] + '\n')

        print(f"  ✅ {split_name}: {len(samples)} 条 → {out_path}")
    conn.close()
    print(f"\n📦 导出完成: {output_dir}")

# ── 导入 session ──────────────────────────────────────
def cmd_import_sessions(db_path, sessions_dir, limit=None):
    if not sessions_dir:
        sessions_dir = os.path.expanduser("~/.agent/sessions")

    if not os.path.isdir(sessions_dir):
        print(f"❌ Session 目录不存在: {sessions_dir}")
        return

    conn = get_db(db_path)
    cur = conn.cursor()

    dirs = sorted(os.listdir(sessions_dir))
    if limit:
        dirs = dirs[:limit]

    imported = 0
    for name in dirs:
        session_path = os.path.join(sessions_dir, name)
        conv_path = os.path.join(session_path, "conversation.jsonl")
        if not os.path.isfile(conv_path):
            continue

        cur.execute("SELECT count(*) FROM raw_sessions WHERE session_id = ?", (name,))
        if cur.fetchone()[0] > 0:
            continue

        with open(conv_path, 'r', encoding='utf-8') as f:
            lines = [l.strip() for l in f if l.strip()]
            msg_count = len(lines)

        cur.execute("""
            INSERT INTO raw_sessions (session_id, source_path, status, message_count, channel)
            VALUES (?, ?, 'raw', ?, ?)
        """, (name, conv_path, msg_count, 'tui' if 'tui' in name else 'clawbot'))
        imported += 1

    conn.commit()
    conn.close()
    print(f"✅ 导入完成: {imported} 个 session")

# ── Session 预览 ──────────────────────────────────────
def cmd_preview_session(db_path, session_id):
    if not os.path.isfile(db_path):
        print("❌ 数据库不存在")
        return
    conn = get_db(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM raw_sessions WHERE session_id = ?", (session_id,))
    row = cur.fetchone()
    if not row:
        print(f"❌ Session '{session_id}' 不在数据库中")
        conn.close()
        return

    print(f"\n{'='*50}")
    print(f"  Session: {session_id}")
    print(f"  状态: {row['status']}  |  消息数: {row['message_count']}")
    print(f"{'='*50}")

    conv_path = row['source_path']
    if os.path.isfile(conv_path):
        with open(conv_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        for i, line in enumerate(lines[:20]):
            try:
                data = json.loads(line)
                role = data.get('role', '?')
                content = data.get('content', '')
                text = content.get('text', '')[:80] if isinstance(content, dict) else str(content)[:80]
                print(f"  [{i:3d}] {role:10s} | {text}")
            except:
                print(f"  [{i:3d}] (parse error)")
        if len(lines) > 20:
            print(f"  ... 还有 {len(lines)-20} 条")
    conn.close()

# ── 命令行 ────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="🪴 hyacinth 训练基础设施管理工具",
        epilog="首次使用: python manage.py init"
    )
    parser.add_argument("--db", default=DEFAULT_DB,
                        help=f"数据库路径 (默认: {DEFAULT_DB})")

    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="在 ~/.agent/ 下初始化训练数据库")

    sub.add_parser("stats", help="数据库统计")

    rm = sub.add_parser("register-model", help="注册底模")
    rm.add_argument("name", help="模型名称 (如 qwen-2.5-1.5b-instruct)")
    rm.add_argument("--type", dest="model_type", default="hf", help="模型类型 (hf/gguf)")
    rm.add_argument("--path", default=".", help="模型文件路径")
    rm.add_argument("--params", help="模型参数 JSON")

    sub.add_parser("list-models", help="列出底模")

    cl = sub.add_parser("create-lora", help="创建 LoRA 数据集")
    cl.add_argument("lora_id", help="LoRA 名称 (如 coding-lora-v1)")
    cl.add_argument("--base", dest="base_model", required=True, help="使用的底模")
    cl.add_argument("--desc", dest="description", default="", help="描述")
    cl.add_argument("--capability", help="筛选的功能标签")
    cl.add_argument("--min-quality", type=float, default=0.0, help="最低质量分数")
    cl.add_argument("--params", help="训练超参 JSON")

    sub.add_parser("list-loras", help="列出 LoRA 数据集")

    bd = sub.add_parser("build-dataset", help="构建 LoRA 训练集")
    bd.add_argument("lora_id", help="LoRA 名称")
    bd.add_argument("--split", type=float, default=0.9, help="训练集比例 (默认 0.9)")

    ed = sub.add_parser("export-dataset", help="导出 LoRA 数据集为 JSONL")
    ed.add_argument("lora_id", help="LoRA 名称")
    ed.add_argument("--out", dest="output_dir", default="./exports", help="导出目录")

    im = sub.add_parser("import-sessions", help="导入 Session 原始数据")
    im.add_argument("--dir", dest="sessions_dir", help="session 目录路径")
    im.add_argument("--limit", type=int, help="限制导入数量")

    ps = sub.add_parser("preview-session", help="预览 Session 对话")
    ps.add_argument("session_id", help="Session ID")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init()
    elif args.command == "stats":
        cmd_stats(args.db)
    elif args.command == "register-model":
        params = json.loads(args.params) if args.params else None
        cmd_register_model(args.name, args.model_type, args.path, params)
    elif args.command == "list-models":
        cmd_list_models()
    elif args.command == "create-lora":
        cf = {"capability": args.capability, "min_quality": args.min_quality} if args.capability else None
        params = json.loads(args.params) if args.params else None
        cmd_create_lora(args.db, args.lora_id, args.base_model, args.description, cf, params)
    elif args.command == "list-loras":
        cmd_list_loras(args.db)
    elif args.command == "build-dataset":
        cmd_build_dataset(args.db, args.lora_id, args.split)
    elif args.command == "export-dataset":
        cmd_export_dataset(args.db, args.lora_id, args.output_dir)
    elif args.command == "import-sessions":
        cmd_import_sessions(args.db, args.sessions_dir, args.limit)
    elif args.command == "preview-session":
        cmd_preview_session(args.db, args.session_id)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
