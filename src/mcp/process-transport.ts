import type { ChildProcess } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

export class ProcessTransport implements Transport {
  private readBuffer = new ReadBuffer();
  private onDataHandler: (data: Buffer) => void;
  private onCloseHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
  private onErrorHandler: (err: Error) => void;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(private proc: ChildProcess) {
    this.onDataHandler = (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.processReadBuffer();
    };
    this.onCloseHandler = () => {
      this.onclose?.();
    };
    this.onErrorHandler = (err: Error) => {
      this.onerror?.(err);
    };
  }

  async start(): Promise<void> {
    if (!this.proc.stdout) {
      throw new Error('Process stdout is not available');
    }
    this.proc.stdout.on('data', this.onDataHandler);
    this.proc.on('close', this.onCloseHandler);
    this.proc.on('error', this.onErrorHandler);
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (!this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('Process stdin is not available');
    }
    const line = serializeMessage(message);
    this.proc.stdin.write(line);
  }

  async close(): Promise<void> {
    this.proc.stdout?.off('data', this.onDataHandler);
    this.proc.off('close', this.onCloseHandler);
    this.proc.off('error', this.onErrorHandler);
    this.readBuffer.clear();
    this.onclose?.();
  }

  private processReadBuffer(): void {
    while (true) {
      const message = this.readBuffer.readMessage();
      if (message === null) break;
      if (this.onmessage) {
        this.onmessage(message);
      }
    }
  }
}
