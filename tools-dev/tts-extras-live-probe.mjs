/**
 * 活体验证：extras 真的能传进 breeze server 并生效吗？
 *
 * 为什么非做不可：上一批提交（say extras + 白名单）有三条**承载设计的论断**，
 * 而它们当时全部只有单测覆盖（单测只证明 pickExtras 过滤逻辑对，不证明链路通）：
 *
 *   论断 A：audio.cpp 对**未知** request option 是**整单失败**（不是忽略）
 *           ⇒ 这是"为什么必须有白名单"的唯一依据。若其实是忽略，白名单就只是保险，注释得改。
 *   论断 B：同一个 seed ⇒ 输出逐字节相同（证明 seed 被真正消费，而不是被丢弃）
 *   论断 C：不同 seed ⇒ 输出不同（证明 extras 不是摆设）
 *   论断 D：走**引擎模块**（dist 里的 createBreezeTts2Engine + extras）与直连 server 结果一致
 *           ⇒ 证明 say → plugin → engine 这条链没有在半路把 extras 丢掉
 *
 * 判据一律是可测量的字节数 / HTTP 状态码，不靠"看起来正常"。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:8189';
const REF_WAV = 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.wav';
const REF_TXT = 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.txt';
const TEXT = '今天天气不错，我们一起出去散散步吧。';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

async function raw(options, label) {
  const body = {
    model: 'breeze-tts-2',
    input: TEXT,
    response_format: 'wav',
    voice_ref: REF_WAV,
    reference_text: fs.readFileSync(REF_TXT, 'utf8').trim(),
  };
  if (options !== undefined) body.options = options;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260);
    return { label, ok: false, status: res.status, err: txt, ms };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { label, ok: true, status: res.status, bytes: buf.length, hash: sha(buf), ms };
}

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.json())
  .catch(() => null);
if (!health || health.status !== 'ok') {
  console.log(`❌ 8189 未就绪 ${JSON.stringify(health)}`);
  process.exit(1);
}
console.log('✅ server 就绪\n');

// ── 论断 A：未知 option 是失败还是忽略？──────────────────────────
console.log('=== 论断 A：未知 request option 的行为 ===');
const a1 = await raw({ language: 'zh' }, '未知键 language');
console.log(
  a1.ok
    ? `  ⚠️ HTTP ${a1.status} 竟然成功（${a1.bytes} B）⇒ 未知 option 被**忽略**，白名单不是硬需求，注释需改`
    : `  ✅ HTTP ${a1.status} 失败 ⇒ 确认"未知 option 整单失败"\n     响应：${a1.err}`,
);
const a2 = await raw({ totally_bogus_key_xyz: 1 }, '未知键 totally_bogus_key_xyz');
console.log(
  a2.ok
    ? `  ⚠️ HTTP ${a2.status} 成功 ⇒ 同上，未知键被忽略`
    : `  ✅ HTTP ${a2.status} 失败 ⇒ 第二个未知键同样被拒`,
);

// ── 论断 B/C：seed 是否真的被消费 ────────────────────────────────
console.log('\n=== 论断 B/C：seed 是否真的被消费 ===');
const b1 = await raw({ seed: 42, temperature: 0.7 }, 'seed=42 #1');
const b2 = await raw({ seed: 42, temperature: 0.7 }, 'seed=42 #2');
const c1 = await raw({ seed: 777, temperature: 0.7 }, 'seed=777');

if (b1.ok && b2.ok && c1.ok) {
  console.log(`  seed=42  #1 → ${b1.bytes} B  sha=${b1.hash}`);
  console.log(`  seed=42  #2 → ${b2.bytes} B  sha=${b2.hash}`);
  console.log(`  seed=777    → ${c1.bytes} B  sha=${c1.hash}`);
  console.log(
    b1.hash === b2.hash
      ? '  ✅ 同 seed 逐字节相同 ⇒ seed 被真正消费（论断 B 成立）'
      : '  ⚠️ 同 seed 结果不同 ⇒ seed 可能没生效，或是非确定采样',
  );
  console.log(
    b1.hash !== c1.hash
      ? '  ✅ 不同 seed 结果不同 ⇒ extras 确实影响输出（论断 C 成立）'
      : '  ⚠️ 不同 seed 结果仍相同 ⇒ extras 可能被丢弃',
  );
} else {
  console.log('  ❌ seed 用例有失败，跳过对比');
}

// ── 论断 D：走引擎模块，extras 是否一路通到底 ────────────────────
console.log('\n=== 论断 D：引擎模块（dist）链路 ===');
let engineHash = '';
try {
  const mod = await import('../dist/tts/engines/breeze-tts2.js');
  const engine = mod.createBreezeTts2Engine(() => ({
    cliPath: 'F:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe',
    modelPath: 'F:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf',
    backend: 'cuda',
    device: 0,
    serverUrl: BASE,
    voicesDir: path.dirname(REF_WAV),
  }));
  const caps = engine.capabilities();
  console.log(`  capabilities.extras = [${(caps.extras ?? []).join(', ')}]`);
  const wav = await engine.synthesize(TEXT, {
    voice: 'breeze_reference_audio',
    extras: { seed: 42, temperature: 0.7, language: 'zh' /* 故意塞一个白名单外的 */ },
  });
  engineHash = sha(wav);
  console.log(`  经引擎合成 → ${wav.length} B  sha=${engineHash}`);
  console.log(
    b1.ok && engineHash === b1.hash
      ? '  ✅ 与直连 server 的 seed=42 完全一致 ⇒ extras 一路通到底（论断 D 成立）'
      : b1.ok
        ? `  ⚠️ 与直连不一致（直连 sha=${b1.hash}）⇒ 检查是否多传了白名单外的键导致行为差异`
        : '  （无直连基线可比）',
  );
} catch (err) {
  console.log(`  ❌ 引擎调用失败：${err instanceof Error ? err.message : String(err)}`);
}

console.log('\n=== 结论摘要 ===');
console.log(`  A 未知 option：${a1.ok ? '被忽略（白名单非硬需求）' : '整单失败（白名单必要）'}`);
console.log(`  B seed 确定性：${b1.ok && b2.ok && b1.hash === b2.hash ? '确定' : '待查'}`);
console.log(`  C seed 有效：${b1.ok && c1.ok && b1.hash !== c1.hash ? '有效' : '待查'}`);
console.log(`  D 引擎链路：${engineHash && b1.ok && engineHash === b1.hash ? '通' : '待查'}`);
