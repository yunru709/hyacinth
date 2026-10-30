import { WatchService } from '../dist/watch/watch-service.js';
import { createDefaultProbeRegistry } from '../dist/watch/probes/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const svc = new WatchService({
  registry: createDefaultProbeRegistry(),
  onEvent: (e) => events.push(e),
  defaultIntervalMs: 200,
  defaultCooldownMs: 1000,
});

let pass = true;

// 1. exit：监测一个绝对不存在的进程 → 首帧 met 但 fireOnFirstSatisfied=false ⇒ 应 0 事件（修复前会 1）
const h1 = svc.start({ kind: 'process', name: 'definitely_not_running_xyz_123', expect: 'exit' }, { intervalMs: 200, settleFrames: 1 });
await sleep(800);
const exitEvents = events.length;
console.log(`exit + 进程不存在 → events=${exitEvents} (expect 0)`);
pass = pass && exitEvents === 0;

// 2. running：监测当前进程（活着）→ 首帧 met 且 fireOnFirstSatisfied=true ⇒ 应 >=1 事件
events.length = 0;
const h2 = svc.start({ kind: 'process', pid: process.pid, expect: 'running' }, { intervalMs: 200, settleFrames: 1 });
await sleep(600);
const runEvents = events.length;
console.log(`running + 进程存活 → events=${runEvents} (expect >=1)`);
pass = pass && runEvents >= 1;

// 3. port closed：监测一个肯定没人监听的端口 → 首帧 met 但应 0 事件
events.length = 0;
const h3 = svc.start({ kind: 'port', port: 59999, expect: 'closed', allowPrivateHost: true }, { intervalMs: 200, settleFrames: 1 });
await sleep(800);
const portEvents = events.length;
console.log(`port closed + 端口本来关 → events=${portEvents} (expect 0)`);
pass = pass && portEvents === 0;

for (const h of [h1, h2, h3]) { try { svc.stop(h.watchId); } catch {} }
console.log(pass ? '\n=== PASS ===' : '\n=== FAIL ===');
process.exit(pass ? 0 : 1);
