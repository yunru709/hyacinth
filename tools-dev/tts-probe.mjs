#!/usr/bin/env node
/**
 * tts-probe.mjs —— 打本地 CosyVoice 服务，记录 wall 与音频时长（2026-10-25）
 *
 * 用途：验证 server.py「撞顶不重试」改动。
 *   判据：若某次 wall ≈ max_len×40ms（21 字 ⇒ 16.8 s）且**不再翻倍**，
 *        同时在服务日志里出现「撞顶不重试」，即改动生效。
 *
 * 用法：node tools-dev/tts-probe.mjs [次数] [文本]
 */

const N = Number(process.argv[2] ?? 3);
const TEXT =
  process.argv[3] ??
  '孑遗你好，今天我们在测试语音合成的稳定性问题，希望这一次能够顺利收尾。';

/** 从 WAV 头算时长（秒） */
function wavDuration(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!sampleRate || !channels || !bits) return null;
      // data 头里的 size 可能为 0/占位，按实际剩余字节算更稳
      const bytes = Math.min(size || buf.length - body, buf.length - body);
      return bytes / (sampleRate * channels * (bits / 8));
    }
    off = body + size + (size % 2);
  }
  return null;
}

async function once(i) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:3178/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEXT }),
    });
    const wall = (Date.now() - t0) / 1000;
    if (!res.ok) {
      const body = await res.text();
      return { i, ok: false, wall, status: res.status, err: body.slice(0, 200) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { i, ok: true, wall, bytes: buf.length, dur: wavDuration(buf) };
  } catch (e) {
    return { i, ok: false, wall: (Date.now() - t0) / 1000, err: e.message };
  }
}

const text = TEXT;
console.log(`text = ${text}`);
console.log(`chars = ${text.length}\n`);
console.log('轮次 | wall(s) | 音频时长(s) | 字节');
console.log('-'.repeat(46));

const rows = [];
for (let i = 1; i <= N; i++) {
  const r = await once(i);
  rows.push(r);
  if (r.ok) {
    console.log(
      `${String(i).padStart(4)} | ${r.wall.toFixed(2).padStart(7)} | ${(r.dur ?? 0).toFixed(2).padStart(11)} | ${r.bytes}`,
    );
  } else {
    console.log(`${String(i).padStart(4)} | ${r.wall.toFixed(2).padStart(7)} | ✗ ${r.err}`);
  }
}

const ok = rows.filter((r) => r.ok);
if (ok.length) {
  const walls = ok.map((r) => r.wall);
  const durs = ok.map((r) => r.dur ?? 0);
  console.log(`\nwall: min=${Math.min(...walls).toFixed(2)}s max=${Math.max(...walls).toFixed(2)}s`);
  console.log(`音频: min=${Math.min(...durs).toFixed(2)}s max=${Math.max(...durs).toFixed(2)}s`);
  // 撞顶判据：21 字文本 token N≈21 ⇒ max_len≈420 帧 ⇒ ≈16.8 s
  const capped = walls.filter((w) => w > 14);
  console.log(`疑似撞顶次数（wall>14s）: ${capped.length}`);
}
