// 冒烟：用 dist 产物验证 QQ 渠道能连上 NapCat（不依赖重启）
import { QqClient, extractText } from '../dist/channels/plugins/qq/qq-client.js';

const client = new QqClient({
  httpUrl: 'http://127.0.0.1:3000',
  wsUrl: 'ws://127.0.0.1:3001',
  httpTimeoutMs: 8000,
});

const info = await client.getLoginInfo();
console.log('[SMOKE] get_login_info =>', JSON.stringify(info));

const st = await client.getStatus();
console.log('[SMOKE] get_status =>', JSON.stringify(st));

// 连 WS 5 秒，看能否收到事件（无消息则只验连接）
let connected = false;
let events = 0;
client.setHandlers({
  onConnected: () => { connected = true; console.log('[SMOKE] ws connected'); },
  onEvent: (ev) => { events++; console.log('[SMOKE] event:', ev.post_type); },
});
client.connect();

await new Promise((r) => setTimeout(r, 5000));
client.close();

console.log('[SMOKE] connected =', connected, ' events =', events);
console.log(connected ? '[SMOKE] PASS' : '[SMOKE] FAIL (ws 未连上)');
process.exit(connected ? 0 : 1);
