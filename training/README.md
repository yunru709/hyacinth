# 🪴 hyacinth 训练基础设施

hyacinth 内置的训练数据管线与模型仓库管理功能，用于微调本地模型（LoRA/QLoRA）。

## 目录结构

```
training/                        ← 随 npm 包发布
├── training.db                  ← 空数据库模板（含完整 schema）
├── schema.sql                   ← 建表 SQL（可追溯）
├── README.md
├── pipeline/                    ← 数据清洗管线设计文档
└── scripts/
    └── manage.py                ← CLI 管理工具

model-repo/                      ← 随 npm 包发布
├── registry.json                ← 全局注册表（底模↔LoRA 映射）
├── base_models/                 ← 底模注册信息
│   └── registry.json
└── loras/                       ← LoRA 注册信息
    └── registry.json
```

## 快速上手

```bash
# 首次使用：初始化数据库（创建 ~/.agent/training.db）
python scripts/manage.py init

# 查看统计
python scripts/manage.py stats

# 导入 Agent session 原始数据
python scripts/manage.py import-sessions

# 注册一个底模
python scripts/manage.py register-model qwen-2.5-1.5b-instruct --path /path/to/model

# 创建 LoRA 数据集
python scripts/manage.py create-lora coding-lora-v1 --base qwen-2.5-1.5b-instruct --capability coding

# 查看 LoRA 数据集
python scripts/manage.py list-loras

# 从清洗数据构建训练/验证集
python scripts/manage.py build-dataset coding-lora-v1

# 导出为 JSONL（喂给训练框架）
python scripts/manage.py export-dataset coding-lora-v1 --out ./exports
```

## 数据库

默认路径：`~/.agent/training.db`

6 张表：`raw_sessions`（原始数据追踪）、`cleaned_samples`（清洗后样本）、
`sample_capabilities`（功能标签）、`sample_tags`（自定义标签）、
`lora_datasets`（数据集定义）、`lora_sample_map`（样本↔LoRA 映射）。

## 数据清洗规则

原始 session 对话 → 清洗后训练样本：

- user 消息 → 保留
- assistant 的 thinking（推理过程）→ 保留，作为 CoT 训练信号
- assistant 的 text → 保留
- tool_use / tool_result → 文本化
- 过短对话（< 3 字）→ 过滤
- 过长消息 → 截断/分段
