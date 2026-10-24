// ============================================================
// UI 契约层 — 文件预览域（preview.*）
// ============================================================
// 覆盖 WebUI「预览」栏的全部数据面：
//   preview.meta     当前根 / 名称 / 各项上限
//   preview.list     某个目录的一级条目（相对当前根）
//   preview.read     文本文件内容（UTF-8，超长截断；二进制回 binary 标记）
//   preview.browse   目录选择器（绝对路径，只回目录名）——仅限回环连接
//   preview.setRoot  切换预览根目录 —— 仅限回环连接
//   preview.rawUrl   签发原始字节的 HTTP 地址（img/iframe 加载用）
//
// fs 安全校验（fail-closed：相对根路径 / realpath 防符号链接逃逸 / .git 恒不列）
// 全部在 gateway/preview-service.ts —— 与 HTTP 路由共享同一实例，本域零 fs 依赖
// （协议层零业务依赖，P5-2；服务经 backend 注入，结构化接口在下方）。
//
// 字节流不进 JSON 协议：<img>/<iframe>/<a download> 由浏览器直接加载，塞不进
// RPC。模式与 companion 域的 makeVoiceUrl/makeSceneUrl 相同 —— 契约层**签发
// URL**（含 ?token=，服务端嵌入），前端不硬编码任何 HTTP 路径。未来新 UI 只
// 依赖本域方法面 + 后端签发的 url，即可完整重建预览栏。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实实现：gateway/preview-service.ts 的 PreviewService）
// ────────────────────────────────────────────────────────────

export interface PreviewServiceLike {
  meta(): Record<string, unknown>;
  list(rel: string | undefined | null, all: boolean): Promise<{ path: string; entries: unknown[]; truncated: boolean }>;
  read(rel: string | undefined | null): Promise<Record<string, unknown> & { path: string }>;
  browse(dir: string | undefined | null): Promise<Record<string, unknown>>;
  setRoot(root: string | undefined | null): Promise<Record<string, unknown>>;
  resolve(rel: string | undefined | null): { abs: string; rel: string };
}

// ────────────────────────────────────────────────────────────
// 文件预览域选项
// ────────────────────────────────────────────────────────────

export interface PreviewDomainOptions {
  /** 动态获取预览服务（HTTP 通道与协议域共享同一实例；未装配时方法报错） */
  getService: () => PreviewServiceLike | null;
  /** 原始字节 URL 签发器（服务端嵌入 ?token=；缺省相对路径 /api/fs/raw） */
  makeRawUrl: (rel: string) => string;
  /**
   * 连接是否来自回环。browse/setRoot 等价于"扩大服务端可读范围"，只允许本机
   * （与 HTTP 路由同一安全边界）。缺省 false = fail-closed：装配侧不确定时一律拒绝。
   */
  loopback?: boolean;
}

// ────────────────────────────────────────────────────────────
// 文件预览域工厂
// ────────────────────────────────────────────────────────────

export function createPreviewDomain(options: PreviewDomainOptions): DomainHandler {
  const { getService, makeRawUrl } = options;
  const loopback = options.loopback ?? false;

  const svc = (): PreviewServiceLike => {
    const s = getService();
    if (!s) throw new Error('preview 服务未装配（该 UI 通道未接入文件预览）');
    return s;
  };
  const needLoopback = (): void => {
    if (!loopback) throw new Error('该操作只允许在本机（回环连接）进行');
  };

  return {
    // ── preview.meta ───────────────────────────────────────
    meta(): Record<string, unknown> {
      return svc().meta();
    },

    // ── preview.list ───────────────────────────────────────
    async list(params: unknown): Promise<{ path: string; entries: unknown[]; truncated: boolean }> {
      const p = (params ?? {}) as { path?: string; all?: boolean | string };
      return svc().list(p.path, p.all === true || p.all === '1' || p.all === 'true');
    },

    // ── preview.read ───────────────────────────────────────
    // url 字段：二进制（image/pdf/html/其它）预览由浏览器按 url 拉原始字节；
    // 文本结果同样带上 —— 消费端无需自己拼地址（前端不硬编码 HTTP 路径）。
    async read(params: unknown): Promise<Record<string, unknown> & { url: string }> {
      const p = (params ?? {}) as { path?: string };
      const result = await svc().read(p.path);
      return { ...result, url: makeRawUrl(result.path) };
    },

    // ── preview.browse ─────────────────────────────────────
    async browse(params: unknown): Promise<Record<string, unknown>> {
      needLoopback();
      const p = (params ?? {}) as { dir?: string };
      return svc().browse(p.dir);
    },

    // ── preview.setRoot ────────────────────────────────────
    async setRoot(params: unknown): Promise<Record<string, unknown>> {
      needLoopback();
      const p = (params ?? {}) as { root?: string };
      return svc().setRoot(p.root);
    },

    // ── preview.rawUrl ─────────────────────────────────────
    // 签发前先过一遍路径校验（fail-closed 预检）：越界/不存在的路径不签地址，
    // 让调用方第一时间拿到与 read 一致的错误，而不是拿到一个注定 403/404 的 URL。
    async rawUrl(params: unknown): Promise<{ url: string; path: string }> {
      const p = (params ?? {}) as { path?: string };
      const resolved = svc().resolve(p.path);
      return { url: makeRawUrl(resolved.rel), path: resolved.rel };
    },
  };
}
