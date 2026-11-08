// 诊断：直接跑 QqChannel.start()，看能否连上 WS
import { QqChannel } from '../dist/channels/plugins/qq/qq-channel.js';

const ch = new QqChannel();

let gotEvent = false;
ch.onEvent(async (ev) => {
  gotEvent = true;
  console.log('[EVENT]', ev.type);
});

console.log('[1] 调用 start() ...');
try {
  await ch.start({
    enabled: true,
    httpUrl: 'http://127.0.0.1:3000',
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    allowFrom: [746896396],
    groupAllowFrom: [],
    requireMention: true,
    selfId: 3994097359,
    tuiSync: false,
    textChunkLimit: 4000,
    httpTimeoutMs: 15000,
    reconnectIntervalMs: 3000,
  });
  console.log('[2] start() 返回，status =', ch.getStatus());
} catch (e) {
  console.error('[2] start() 抛错:', e instanceof Error ? e.message : e);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 8000));
console.log('[3] 8 秒后 status =', ch.getStatus(), ' gotEvent =', gotEvent);

await ch.stop();
console.log('[4] 已 stop');
process.exit(ch.getStatus() === 'stopped' ? 0 : 1);
