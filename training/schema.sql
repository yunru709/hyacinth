-- ============================================================
-- Schema: 训练数据管线数据库
-- 用途: 存储原始 session 数据、清洗后训练样本、LoRA 数据集管理
-- ============================================================

-- ── 原始数据追踪 ─────────────────────────────────
CREATE TABLE IF NOT EXISTS raw_sessions (
  session_id    TEXT PRIMARY KEY,
  source_path   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'raw',     -- raw / processing / done / archived
  message_count INTEGER DEFAULT 0,
  token_est     INTEGER DEFAULT 0,
  channel       TEXT DEFAULT 'tui',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at  TEXT
);

-- ── 清洗后的训练样本 ──────────────────────────────
CREATE TABLE IF NOT EXISTS cleaned_samples (
  id            TEXT PRIMARY KEY,                 -- hash(session_id + turn_index)
  session_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,                 -- 在 session 中的轮次
  messages      TEXT NOT NULL,                    -- JSON: [{"role":"user","content":"..."}, ...]
  token_count   INTEGER DEFAULT 0,
  quality_score REAL DEFAULT 0.0,                 -- 0.0 ~ 1.0
  has_tool_use  INTEGER DEFAULT 0,                -- 是否包含工具调用
  has_thinking  INTEGER DEFAULT 0,                -- 是否包含推理过程
  source_raw    TEXT,                             -- 原始数据备份（JSON）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES raw_sessions(session_id)
);

-- ── 样本功能标签（用于 LoRA 分类）──────────────────
CREATE TABLE IF NOT EXISTS sample_capabilities (
  sample_id     TEXT NOT NULL,
  capability    TEXT NOT NULL,                    -- coding / chat / tool_use / general / reasoning / ...
  confidence    REAL DEFAULT 0.5,                 -- 分类置信度
  tagged_by     TEXT DEFAULT 'auto',              -- auto / manual / agent
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sample_id, capability),
  FOREIGN KEY (sample_id) REFERENCES cleaned_samples(id)
);

-- ── 样本自定义标签（更细粒度的标记）───────────────
CREATE TABLE IF NOT EXISTS sample_tags (
  sample_id     TEXT NOT NULL,
  tag           TEXT NOT NULL,                    -- "bug-fix", "api-doc", "greeting", "error-recovery"...
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sample_id, tag),
  FOREIGN KEY (sample_id) REFERENCES cleaned_samples(id)
);

-- ── LoRA 数据集定义 ──────────────────────────────
CREATE TABLE IF NOT EXISTS lora_datasets (
  lora_id       TEXT PRIMARY KEY,                 -- "coding-lora-v1"
  base_model    TEXT NOT NULL,                    -- "Qwen2.5-1.5B-Instruct"
  description   TEXT,
  capability_filter TEXT,                         -- 筛选条件 JSON，如 {"capability": "coding"}
  train_count   INTEGER DEFAULT 0,
  val_count     INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft / ready / training / done / deployed
  params        TEXT,                             -- 训练超参 JSON
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── LoRA 数据集与样本的映射 ──────────────────────
CREATE TABLE IF NOT EXISTS lora_sample_map (
  lora_id       TEXT NOT NULL,
  sample_id     TEXT NOT NULL,
  split         TEXT NOT NULL DEFAULT 'train',    -- train / val
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lora_id, sample_id),
  FOREIGN KEY (lora_id) REFERENCES lora_datasets(lora_id),
  FOREIGN KEY (sample_id) REFERENCES cleaned_samples(id)
);

-- ── 索引 ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_samples_session ON cleaned_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_samples_quality ON cleaned_samples(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_capabilities_sample ON sample_capabilities(sample_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_type ON sample_capabilities(capability);
CREATE INDEX IF NOT EXISTS idx_tags_sample ON sample_tags(sample_id);
CREATE INDEX IF NOT EXISTS idx_lora_map_dataset ON lora_sample_map(lora_id);
CREATE INDEX IF NOT EXISTS idx_lora_map_split ON lora_sample_map(split);
