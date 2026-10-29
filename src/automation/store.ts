/**
 * AutomationRule 存储与加载（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 存储位置与格式
 * ────────────────────────────────────────────────────────────────────────────
 *   ~/.agent/automations.json
 *   { "version": 1, "rules": [ AutomationRule, ... ] }
 *
 * 为什么单独一个文件，而不是塞进 tasks.json：
 *   tasks.json 是 **时间调度** 的存储（有 nextRunAt/runCount/periodStartAt 等运行时状态）。
 *   AutomationRule 是 **链路定义**（纯配置，无运行时状态 —— 状态应该分开记，
 *   否则"改配置"和"改统计"会互相冲掉，且 diff 不可读）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 加载语义（沿用 tool-links / extension-registry 的"保旧"模式）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 文件不存在 ⇒ 空规则集（不报错：还没配过是正常状态）
 *   · JSON 坏 / 结构错 ⇒ **不动当前规则**（保旧）+ 返回 errors（调用方 warn）
 *   · 单条规则校验失败 ⇒ 剔除该条，其它照常生效（因为一条写错不该拖垮全部规则）
 *     ⚠️ 与 validate 的"整份拒绝"不冲突：validate 管**一条**，这里管**一个文件**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 可观测（用户 2026-10-30 要求"过程中及时写好日志"）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 加载结果的每一条错误都带索引与原因，便于定位是哪条规则写错了
 *   · 成功加载时报告条数（"0 条"和"3 条但全被剔除"是完全不同的情况，必须区分）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AutomationRule } from './types.js';
import type { ValidationContext } from './validate.js';
import { validateRule } from './validate.js';

export const AUTOMATIONS_VERSION = 1;

export interface AutomationFile {
  version: number;
  rules: AutomationRule[];
}

/** 规则文件路径（全局单层，与 tool-links.json 同法） */
export function automationsPath(): string {
  return path.join(os.homedir(), '.agent', 'automations.json');
}

export interface LoadResult {
  rules: AutomationRule[];
  /** 每条形如 `rules[2]: 未知的 probe kind "xxx"` */
  errors: string[];
  path: string;
  existed: boolean;
}

/**
 * 读盘 + 逐条校验。
 * **不抛**：文件缺失、JSON 坏、结构错都折进返回值。
 *
 * @param ctx 校验所需的外部知识（probe kinds / tool names / handlers / events）
 */
export function loadAutomationRules(
  ctx: ValidationContext,
  /** 测试隔离用；省略则用 ~/.agent/automations.json */
  filePath: string = automationsPath(),
): LoadResult {
  const p = filePath;

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    // 没配过是正常状态，不是错误
    return { rules: [], errors: [], path: p, existed: false };
  }

  let parsed: unknown;
  try {
    // 注意：用 JSON.parse 直接吃字符串。历史教训——若文件带 UTF-8 BOM，
    // 这里会抛 "Unexpected token '﻿'"。写文件务必用不带 BOM 的方式。
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      rules: [],
      errors: [`invalid JSON: ${(err as Error).message}`],
      path: p,
      existed: true,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rules: [], errors: ['根节点必须是对象'], path: p, existed: true };
  }

  const root = parsed as { version?: unknown; rules?: unknown };
  const errors: string[] = [];

  if (typeof root.version === 'number' && root.version !== AUTOMATIONS_VERSION) {
    errors.push(`不支持的 version ${root.version}（期望 ${AUTOMATIONS_VERSION}）`);
  }
  if (!Array.isArray(root.rules)) {
    errors.push('"rules" 必须是数组');
    return { rules: [], errors, path: p, existed: true };
  }

  const rules: AutomationRule[] = [];
  const seenIds = new Set<string>();

  root.rules.forEach((item, i) => {
    const result = validateRule(item, ctx);
    if (!result.rule) {
      // 一条写错不该拖垮整个文件 —— 记下来、跳过、其余照常
      errors.push(`rules[${i}]: ${result.errors.join('; ')}`);
      return;
    }
    const r = result.rule;
    if (seenIds.has(r.id)) {
      errors.push(`rules[${i}]: id "${r.id}" 重复（后者被忽略）`);
      return;
    }
    seenIds.add(r.id);
    rules.push(r);
  });

  return { rules, errors, path: p, existed: true };
}

/** 写盘（缩进 2，便于人读/diff；写入不带 BOM） */
export function saveAutomationRules(
  rules: AutomationRule[],
  /** 测试隔离用；省略则用 ~/.agent/automations.json */
  filePath: string = automationsPath(),
): void {
  const p = filePath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const file: AutomationFile = { version: AUTOMATIONS_VERSION, rules };
  fs.writeFileSync(p, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

// ────────────────────────────────────────────────────────────────────────────
// 当前生效规则（进程级持有者）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 为什么模块级单例：规则是**进程级配置**（一个文件、一个真相），
 * 与"每会话一份"的语义不符；热更也只需更新一处 ⇒ 所有事件源立刻看到新规则。
 * （与 tool-links 的 currentManifest 同法。）
 */
let currentRules: AutomationRule[] = [];

/** 当前生效规则（消费者每次读它 ⇒ 热更即时生效） */
export function getCurrentAutomationRules(): AutomationRule[] {
  return currentRules;
}

export function setCurrentAutomationRules(rules: AutomationRule[]): void {
  currentRules = rules;
}

export interface InitResult {
  applied: boolean;
  /** 实际生效的规则条数 */
  count: number;
  errors: string[];
  path: string;
  existed: boolean;
}

/**
 * 读盘 → 逐条校验 → 装进当前规则（启动时调用一次；文件热更时也调它）。
 *
 * 语义与 initToolLinksFromDisk 对齐：
 *   · 文件不存在 ⇒ 清空当前规则（applied=true, count=0）
 *   · JSON/结构错 ⇒ **保旧**（applied=false）
 *   · 部分规则非法 ⇒ 剔非法、装其余（applied=true, count=合法数, errors 非空）
 */
export function initAutomationsFromDisk(ctx: ValidationContext): InitResult {
  const { rules, errors, path: p, existed } = loadAutomationRules(ctx);

  // JSON 坏 / 根结构错 ⇒ 一份都不采信，保旧
  const fatal = errors.some((e) => e.startsWith('invalid JSON') || e.startsWith('根节点') || e.startsWith('"rules"') || e.startsWith('不支持的 version'));
  if (fatal) {
    return { applied: false, count: currentRules.length, errors, path: p, existed };
  }

  currentRules = rules;
  return { applied: true, count: rules.length, errors, path: p, existed };
}
