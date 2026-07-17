// ============================================================
// ClawbotAuthManager — 二维码授权 + bot_token 生命周期管理
// ============================================================
//
// 完整授权流程：
//   1. 启动时检查是否有已缓存的 bot_token
//   2. 没有 → 调用 get_bot_qrcode 获取二维码
//   3. 输出二维码 URL（终端 ASCII / TUI / 文件）
//   4. 轮询 get_qrcode_status，直到 confirmed / expired
//   5. 缓存 bot_token + 过期时间（7 天）
//   6. 每日检查剩余有效期，< 2 天时告警
//
// 状态机：
//   wait → scaned → confirmed（成功）
//   wait → expired（过期，重新获取）
//   scaned_but_redirect → 切换轮询节点
//   need_verifycode → 需要配对码
//   binded_redirect → 已有绑定跳转
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { ClawbotClient, type QRCodeResult, type QRCodeStatusResult } from './clawbot-client.js';

// ── 常量 ──────────────────────────────────────────────────────

/** bot_token 有效期（毫秒），7 天 */
const TOKEN_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/** 提前告警阈值（毫秒），2 天 */
const TOKEN_WARN_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;

/** 二维码轮询间隔（毫秒） */
const QR_POLL_INTERVAL_MS = 2000;

/** 单次二维码最大轮询时间（毫秒），3 分钟 */
const QR_MAX_POLL_MS = 3 * 60 * 1000;

// ── 持久化文件 ────────────────────────────────────────────────

function getTokenFilePath(): string {
  return path.join(process.cwd(), '.agent', 'clawbot_token.json');
}

interface TokenCache {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl: string;
  obtainedAt: number;
}

// ── 回调类型 ──────────────────────────────────────────────────

export interface AuthCallbacks {
  /** 二维码需要展示给用户时调用 */
  onQRCode: (qrUrl: string, qrcode: string) => void;
  /** 状态变更时调用 */
  onStatusChange: (status: string) => void;
}

// ── ClawbotAuthManager ────────────────────────────────────────

export class ClawbotAuthManager {
  private botToken = '';
  private botId = '';
  private userId = '';
  private baseUrl: string;
  private obtainedAt = 0;
  private httpTimeoutMs: number;
  private callbacks: AuthCallbacks;
  /** 本轮授权流程的 AbortController，stopPolling 时中止 */
  private abortController: AbortController | null = null;

  constructor(
    baseUrl: string,
    httpTimeoutMs: number,
    callbacks: AuthCallbacks,
  ) {
    this.baseUrl = baseUrl;
    this.httpTimeoutMs = httpTimeoutMs;
    this.callbacks = callbacks;
  }

  // ── 属性 ────────────────────────────────────────────────────

  get token(): string { return this.botToken; }
  get botIdentifier(): string { return this.botId; }
  get userIdentifier(): string { return this.userId; }
  get hasValidToken(): boolean {
    if (!this.botToken) return false;
    const remaining = this.obtainedAt + TOKEN_VALIDITY_MS - Date.now();
    return remaining > 0;
  }

  /** 剩余有效天数 */
  get remainingDays(): number {
    if (!this.botToken) return 0;
    const remaining = this.obtainedAt + TOKEN_VALIDITY_MS - Date.now();
    return Math.max(0, remaining / (24 * 60 * 60 * 1000));
  }

  /** 是否需要告警（剩余 < 2 天） */
  get needsWarning(): boolean {
    if (!this.botToken) return false;
    const remaining = this.obtainedAt + TOKEN_VALIDITY_MS - Date.now();
    return remaining > 0 && remaining < TOKEN_WARN_THRESHOLD_MS;
  }

  // ── 初始化 ───────────────────────────────────────────────────

  /** 尝试从持久化文件恢复 token */
  async restoreFromCache(): Promise<boolean> {
    try {
      const raw = await fs.readFile(getTokenFilePath(), 'utf-8');
      const cache: TokenCache = JSON.parse(raw);
      if (!cache.botToken) return false;

      // 检查是否过期
      if (Date.now() - cache.obtainedAt > TOKEN_VALIDITY_MS) {
        this.callbacks.onStatusChange('Cached token expired, need re-auth');
        return false;
      }

      this.botToken = cache.botToken;
      this.botId = cache.botId ?? '';
      this.userId = cache.userId ?? '';
      this.baseUrl = cache.baseUrl ?? this.baseUrl;
      this.obtainedAt = cache.obtainedAt ?? 0;
      this.callbacks.onStatusChange(`Token restored from cache, ${this.remainingDays.toFixed(1)} days remaining`);
      return true;
    } catch {
      // 首次启动，无缓存文件
      return false;
    }
  }

  /** 直接用已有 token（来自配置 config.channels.clawbot.botToken） */
  setTokenDirect(token: string, botId?: string, userId?: string): void {
    this.botToken = token;
    this.botId = botId ?? '';
    this.userId = userId ?? '';
    this.obtainedAt = Date.now();
    this.saveToCache();
  }

  // ── 授权流程 ────────────────────────────────────────────────

  /**
   * 启动完整扫码授权流程。
   * 返回 Promise<boolean>，true=授权成功，false=用户取消/超时。
   */
  async startAuthorization(baseUrl?: string): Promise<boolean> {
    if (baseUrl) this.baseUrl = baseUrl;

    this.callbacks.onStatusChange('Starting QR code authorization...');

    // 1. 获取二维码
    let qrResult: QRCodeResult;
    try {
      // 获取二维码阶段不需要 bot_token，创建一个临时 client
      const tempClient = new ClawbotClient(this.baseUrl, '', this.httpTimeoutMs);
      qrResult = await tempClient.getQRCode([]);
    } catch (err) {
      this.callbacks.onStatusChange(`Failed to get QR code: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    this.callbacks.onQRCode(qrResult.qrcode_img_content, qrResult.qrcode);

    // 2. 轮询扫码状态
    this.abortController = new AbortController();
    const startTime = Date.now();
    const client = new ClawbotClient(this.baseUrl, '', this.httpTimeoutMs);

    while (Date.now() - startTime < QR_MAX_POLL_MS) {
      // 检查是否被中止
      if (this.abortController.signal.aborted) {
        this.callbacks.onStatusChange('Authorization polling cancelled');
        return false;
      }

      let statusResult: QRCodeStatusResult;
      try {
        statusResult = await client.getQRCodeStatus(qrResult.qrcode);
      } catch (err) {
        this.callbacks.onStatusChange(`QR poll error: ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(QR_POLL_INTERVAL_MS);
        continue;
      }

      this.callbacks.onStatusChange(`QR status: ${statusResult.status}`);

      switch (statusResult.status) {
        case 'confirmed':
          // 成功！
          this.botToken = statusResult.bot_token ?? '';
          this.botId = statusResult.ilink_bot_id ?? '';
          this.userId = statusResult.ilink_user_id ?? '';
          if (statusResult.baseurl) this.baseUrl = statusResult.baseurl;
          this.obtainedAt = Date.now();
          this.saveToCache();
          this.callbacks.onStatusChange(
            `Authorization successful! Bot: ${this.botId}, Token valid for 7 days`,
          );
          return true;

        case 'expired':
          this.callbacks.onStatusChange('QR code expired, retrying...');
          // 递归重试：重新获取二维码
          return this.startAuthorization();

        case 'scaned_but_redirect':
          this.callbacks.onStatusChange('QR scan redirecting...');
          await this.sleep(QR_POLL_INTERVAL_MS);
          continue;

        case 'need_verifycode':
          this.callbacks.onStatusChange('Verification code required on phone');
          await this.sleep(QR_POLL_INTERVAL_MS);
          continue;

        case 'binded_redirect':
          this.callbacks.onStatusChange('Bound session redirect...');
          await this.sleep(QR_POLL_INTERVAL_MS);
          continue;

        case 'scaned':
        case 'wait':
        default:
          await this.sleep(QR_POLL_INTERVAL_MS);
          continue;
      }
    }

    this.callbacks.onStatusChange('Authorization timed out (3 minutes)');
    return false;
  }

  /** 中止正在进行的授权轮询 */
  stopPolling(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── Token 刷新 ──────────────────────────────────────────────

  /**
   * 尝试刷新 token（实际上 ClawBot 不支持静默刷新，只能重新扫码）。
   * 这是给 channel 层调用的 —— 检测到 errcode:-14 时触发重新授权。
   */
  async refreshToken(): Promise<boolean> {
    this.callbacks.onStatusChange('bot_token expired (errcode:-14), starting re-authorization...');
    this.botToken = '';
    return this.startAuthorization();
  }

  /**
   * 每日例行检查：剩余 < 2 天时通过回调告警。
   * 调用方（channel）应在定时任务或启动时调用。
   */
  checkAndWarn(): void {
    if (this.needsWarning) {
      this.callbacks.onStatusChange(
        `⚠️ ClawBot token expires in ${this.remainingDays.toFixed(1)} days. Please re-scan QR code soon.`,
      );
    }
  }

  // ── 持久化 ───────────────────────────────────────────────────

  private async saveToCache(): Promise<void> {
    try {
      const cache: TokenCache = {
        botToken: this.botToken,
        botId: this.botId,
        userId: this.userId,
        baseUrl: this.baseUrl,
        obtainedAt: this.obtainedAt,
      };
      await fs.mkdir(path.dirname(getTokenFilePath()), { recursive: true });
      await fs.writeFile(getTokenFilePath(), JSON.stringify(cache, null, 2), 'utf-8');
    } catch {
      // 写入失败不影响运行
    }
  }

  // ── 工具 ────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
