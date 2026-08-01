#!/usr/bin/env python3
"""
hyacinth 训练入口 — 基于 Unsloth 的 LoRA/QLoRA 微调

用法:
  # 基础训练
  python train.py --model Qwen/Qwen2.5-1.5B-Instruct --data ./exports/coding-lora-v1

  # 指定参数
  python train.py --model Qwen/Qwen2.5-1.5B-Instruct \
    --train-file ./exports/coding-lora-v1_train.jsonl \
    --val-file ./exports/coding-lora-v1_val.jsonl \
    --output ./lora-out \
    --lora-rank 32 --lr 1e-4 --epochs 3

  # 4bit QLoRA（显存不够时）
  python train.py --model Qwen/Qwen2.5-1.5B-Instruct --data ./exports --load-in-4bit

  # 训练完成后合并 LoRA（用于部署）
  python train.py --model Qwen/Qwen2.5-1.5B-Instruct --lora ./lora-out/checkpoint-xxx --merge
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime


def parse_args():
    parser = argparse.ArgumentParser(description="hyacinth LoRA 微调")

    # 模型
    parser.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct",
                        help="底模名称或路径")
    parser.add_argument("--load-in-4bit", action="store_true",
                        help="使用 4bit QLoRA（省显存）")

    # 数据
    parser.add_argument("--data", help="数据集目录（自动找 *_train.jsonl）")
    parser.add_argument("--train-file", help="训练集 JSONL 路径（优先级高于 --data）")
    parser.add_argument("--val-file", help="验证集 JSONL 路径（可选）")

    # LoRA 参数
    parser.add_argument("--lora-rank", type=int, default=16,
                        help="LoRA rank (默认 16)")
    parser.add_argument("--lora-alpha", type=int, default=32,
                        help="LoRA alpha (默认 32)")
    parser.add_argument("--lora-dropout", type=float, default=0,
                        help="LoRA dropout (默认 0)")

    # 训练参数
    parser.add_argument("--lr", type=float, default=2e-4,
                        help="学习率 (默认 2e-4)")
    parser.add_argument("--epochs", type=int, default=3,
                        help="训练轮次 (默认 3)")
    parser.add_argument("--batch-size", type=int, default=2,
                        help="每设备 batch size (默认 2)")
    parser.add_argument("--grad-accum", type=int, default=4,
                        help="梯度累积步数 (默认 4)")
    parser.add_argument("--max-seq-len", type=int, default=2048,
                        help="最大序列长度 (默认 2048)")
    parser.add_argument("--warmup-ratio", type=float, default=0.1,
                        help="warmup 比例 (默认 0.1)")
    parser.add_argument("--output", default="./lora-output",
                        help="输出目录 (默认 ./lora-output)")
    parser.add_argument("--save-steps", type=int, default=100,
                        help="每 N 步保存一次 checkpoint (默认 100)")
    parser.add_argument("--logging-steps", type=int, default=10,
                        help="每 N 步打印一次日志 (默认 10)")

    # 其他
    parser.add_argument("--lora", help="加载已有 LoRA adapter 路径（用于合并/评估）")
    parser.add_argument("--merge", action="store_true",
                        help="合并 LoRA 到底模（需要 --lora）")
    parser.add_argument("--seed", type=int, default=42,
                        help="随机种子 (默认 42)")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅检查配置，不执行训练")

    return parser.parse_args()


def check_env():
    """检查运行环境"""
    missing = []
    try:
        import torch
        print(f"  ✅ PyTorch {torch.__version__}  (CUDA: {torch.cuda.is_available()})")
        if torch.cuda.is_available():
            print(f"     GPU: {torch.cuda.get_device_name(0)}")
            print(f"     VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB")
    except ImportError:
        missing.append("torch")

    try:
        import unsloth
        print(f"  ✅ Unsloth (version unknown)")
    except ImportError:
        missing.append("unsloth")

    try:
        import transformers
        print(f"  ✅ Transformers {transformers.__version__}")
    except ImportError:
        missing.append("transformers")

    try:
        import datasets
        print(f"  ✅ Datasets {datasets.__version__}")
    except ImportError:
        missing.append("datasets")

    try:
        import trl
        print(f"  ✅ TRL (SFTTrainer)")
    except ImportError:
        missing.append("trl")

    if missing:
        print(f"\n❌ 缺少依赖: {', '.join(missing)}")
        print(f"   安装: pip install unsloth transformers datasets trl accelerate bitsandbytes")
        return False
    return True


def find_data_files(data_dir):
    """从目录中自动查找训练/验证 JSONL"""
    train_file = None
    val_file = None
    for f in sorted(os.listdir(data_dir)):
        if f.endswith("_train.jsonl"):
            train_file = os.path.join(data_dir, f)
        elif f.endswith("_val.jsonl"):
            val_file = os.path.join(data_dir, f)
        elif f.endswith(".jsonl") and train_file is None:
            train_file = os.path.join(data_dir, f)

    return train_file, val_file


def prepare_messages_format(examples):
    """将 JSONL 中的 messages 格式转为文本"""
    texts = []
    for msgs in examples["messages"]:
        text = ""
        for msg in msgs:
            role = msg["role"]
            content = msg.get("content", "")
            text += f"<|im_start|>{role}\n{content}<|im_end|>\n"
        text += "<|im_start|>assistant\n"
        texts.append(text)
    return texts


def run_training(args):
    """执行训练"""
    print(f"\n{'='*55}")
    print(f"  🪴 hyacinth — LoRA 微调")
    print(f"{'='*55}")
    print(f"  🕐 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  📦 底模:      {args.model}")
    print(f"  📊 LoRA rank: {args.lora_rank}")
    print(f"  ⚡ 4bit:      {'是' if args.load_in_4bit else '否'}")
    print()

    if not check_env():
        sys.exit(1)

    # 查找数据文件
    if args.train_file:
        train_path = args.train_file
        val_path = args.val_file
    elif args.data:
        train_path, val_path = find_data_files(args.data)
        if not train_path:
            print(f"❌ 在 {args.data} 中未找到 JSONL 文件")
            sys.exit(1)
    else:
        print("❌ 请指定 --train-file 或 --data")
        sys.exit(1)

    print(f"  📂 训练数据: {train_path}")
    if val_path:
        print(f"  📂 验证数据: {val_path}")

    if args.dry_run:
        print(f"\n  ✅ 配置检查通过，dry-run 模式，不执行训练")
        return

    # ── 导入（延迟导入，避免无 GPU 时报错） ──
    import torch
    from unsloth import FastLanguageModel, is_bfloat16_supported
    from datasets import load_dataset
    from trl import SFTTrainer
    from transformers import TrainingArguments

    # 设置种子
    import transformers
    transformers.set_seed(args.seed)

    # ── 1. 加载底模 + LoRA ──
    print(f"\n  ⏳ 加载模型...")
    t0 = time.time()

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_len,
        dtype=None,
        load_in_4bit=args.load_in_4bit,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        lora_dropout=args.lora_dropout,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )

    print(f"  ✅ 模型加载完成 ({time.time()-t0:.1f}s)")
    print(f"     可训练参数: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")

    # ── 2. 加载数据 ──
    print(f"  ⏳ 加载数据...")
    data_files = {"train": train_path}
    if val_path:
        data_files["validation"] = val_path

    dataset = load_dataset("json", data_files=data_files)

    if "validation" not in dataset:
        # 没有验证集则从训练集切分
        split = dataset["train"].train_test_split(test_size=0.1, seed=args.seed)
        dataset["train"] = split["train"]
        dataset["validation"] = split["test"]

    print(f"  ✅ 数据加载完成: {len(dataset['train'])} 训练 / {len(dataset['validation'])} 验证")

    # ── 3. 格式化函数 ──
    def formatting_func(examples):
        """将 messages JSON 转为模型输入文本"""
        texts = []
        for msgs in examples.get("messages", examples.get("conversations", [])):
            if isinstance(msgs, str):
                # 已经是文本格式
                texts.append(msgs)
                continue
            text = tokenizer.apply_chat_template(
                msgs, tokenize=False, add_generation_prompt=False
            )
            texts.append(text)
        return texts

    # ── 4. 训练 ──
    print(f"  ⏳ 开始训练...")
    print()

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset["train"],
        eval_dataset=dataset.get("validation"),
        args=TrainingArguments(
            output_dir=args.output,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accum,
            learning_rate=args.lr,
            warmup_ratio=args.warmup_ratio,
            logging_steps=args.logging_steps,
            save_steps=args.save_steps,
            save_total_limit=3,
            evaluation_strategy="steps" if val_path else "no",
            eval_steps=args.save_steps if val_path else None,
            metric_for_best_model="eval_loss" if val_path else None,
            load_best_model_at_end=True if val_path else False,
            fp16=not is_bfloat16_supported(),
            bf16=is_bfloat16_supported(),
            report_to="none",
            seed=args.seed,
        ),
        packing=False,
    )

    trainer.train()

    # ── 5. 保存 ──
    final_path = os.path.join(args.output, "final")
    print(f"\n  💾 保存 LoRA adapter...")
    model.save_pretrained(final_path)
    tokenizer.save_pretrained(final_path)
    print(f"  ✅ 已保存: {final_path}")

    # 保存训练配置
    config_path = os.path.join(args.output, "training_args.json")
    with open(config_path, 'w') as f:
        json.dump(vars(args), f, indent=2, ensure_ascii=False)
    print(f"  ✅ 训练配置已保存: {config_path}")

    # ── 6. 训练报告 ──
    print(f"\n{'='*55}")
    print(f"  ✅ 训练完成!")
    print(f"  📁 输出: {args.output}")
    print(f"  📁 LoRA: {final_path}")
    print(f"{'='*55}\n")


def merge_lora(args):
    """将 LoRA 合并到底模"""
    print(f"\n{'='*55}")
    print(f"  🪴 hyacinth — LoRA 合并")
    print(f"{'='*55}")

    import torch
    from unsloth import FastLanguageModel

    print(f"  ⏳ 加载底模 + LoRA...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=2048,
        dtype=None,
        load_in_4bit=False,
    )

    from peft import PeftModel
    model = PeftModel.from_pretrained(model, args.lora)

    print(f"  ⏳ 合并中...")
    model = model.merge_and_unload()

    output_dir = args.output or "./merged-model"
    print(f"  💾 保存合并模型...")
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    print(f"  ✅ 合并模型已保存: {output_dir}")


def main():
    args = parse_args()

    if args.merge:
        if not args.lora:
            print("❌ 合并模式需要 --lora 参数")
            sys.exit(1)
        merge_lora(args)
    else:
        run_training(args)


if __name__ == "__main__":
    main()
