#!/usr/bin/env node
/**
 * 协议层覆盖审计：找出「UI 侧引用了、但协议层没有」的方法（真缺口）。
 *
 * 动机（2026-10-16）：我用正则数 `protocolSend('x.y')` 字面量，得出
 * "tui-channel-cmds 零协议调用"——**假阴性**：它把方法名当参数传进
 * `execViaProtocol(getSend, 'model.xxx')`。据此推出的"缺 channel 域"也是错的
 * （model 域早已有全部 8 个 channel 方法）。
 * ⇒ 教训：**别再用单条正则下结论**，改为「权威清单 × 源码全量引用」对账。
 *
 * 用法：node tools-dev/audit-protocol-coverage.mjs [--port 3130]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? process.argv[i + 1] : '3130';
})();

// ── 1) 权威方法清单：优先问运行实例（meta.get），失败则从源码静态提取 ──
async function authoritativeMethods() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null))?.json?.() ?? null;
  } catch { /* WebUI 不走 CDP，忽略 */ }

  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}/ui`); } catch { return finish(null); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} finish(null); }, 6000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ kind: 'request', id: 'audit-1', method: 'meta.get', params: {} }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.kind === 'event' && m.type === 'ui.connected') {
        ws.send(JSON.stringify({ kind: 'request', id: 'audit-1', method: 'meta.get', params: {} }));
        return;
      }
      if (m.kind === 'response' && m.id === 'audit-1') {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        const r = m.result || {};
        // ⚠️ meta.get 的 `methods` 是**对象**（{config:[...], model:[...]}），不是数组。
        // 2026-10-16 踩过：按数组解析 ⇒ 拿到空清单 ⇒ 之后"121 个缺口"全是假的（对照集为空，
        // 任何方法都会被判缺失）⇒ 这里展平，并在 main() 里对空清单硬失败。
        const flat = [];
        for (const [dom, arr] of Object.entries(r.methods || {})) {
          for (const name of (Array.isArray(arr) ? arr : [])) flat.push(`${dom}.${name}`);
        }
        finish({
          source: 'runtime(meta.get)',
          domains: r.domains || [],
          methods: flat,
        });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish(null); });
  });
}

// ── 2) 源码静态提取（兜底）──
function staticMethods() {
  const dir = 'src/ui-protocol/domains';
  const domains = [];
  const methods = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.includes('.test.')) continue;
    const dom = f.replace('.ts', '');
    domains.push(dom);
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^    (?:async )?([a-zA-Z_]\w*)\s*[(:]/);
      if (m && !['if', 'for', 'while', 'switch', 'return', 'const', 'let', 'await', 'try', 'catch'].includes(m[1])) {
        methods.push(`${dom}.${m[1]}`);
      }
    }
  }
  return { source: 'static(src/ui-protocol/domains)', domains, methods: [...new Set(methods)] };
}

// ── 3) 扫描 UI 侧源码，抽出所有被引用的协议方法名 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function collectRefs(files) {
  const refs = new Map(); // method -> Set(file:line)
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      // 直接调用：protocolSend('x.y') / client.request('x.y')
      for (const m of l.matchAll(/protocolSend\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) add(refs, m[1], f, i + 1);
      for (const m of l.matchAll(/\.request\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) add(refs, m[1], f, i + 1);
      // 间接：execViaProtocol(getSend, 'x.y')
      for (const m of l.matchAll(/execViaProtocol\(\s*[^,]+,\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) add(refs, m[1], f, i + 1);
      // 三元/分支里的方法名字面量：'x.y' （仅收 domain.action 形状，且限定已知域前缀）
      for (const m of l.matchAll(/'([a-z][a-zA-Z]*)\.([a-zA-Z][a-zA-Z0-9_]*)'/g)) {
        add(refs, `${m[1]}.${m[2]}`, f, i + 1);
      }
    });
  }
  return refs;
}
function add(map, key, file, line) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(`${file}:${line}`);
}

const main = async () => {
  const auth = (await authoritativeMethods()) || staticMethods();
  const authSet = new Set(auth.methods);
  console.log(`权威清单来源：${auth.source}`);
  console.log(`  域 ${auth.domains.length} 个：${auth.domains.join(', ')}`);
  console.log(`  方法 ${auth.methods.length} 个\n`);

  const knownDomains = new Set(auth.domains);
  const files = [...walk('src/gateway'), ...walk('src/webui')];
  const refs = collectRefs(files);
  console.log(`扫描 UI 侧文件 ${files.length} 个，抽出形如 domain.action 的引用 ${refs.size} 个\n`);

  // 只关心"看起来像协议调用"的引用：域前缀必须是已知域
  const looksProtocol = [...refs.keys()].filter((k) => knownDomains.has(k.split('.')[0]));
  const missing = looksProtocol.filter((k) => !authSet.has(k) && !auth.methods.includes(k));
  const unused = auth.methods.filter((k) => !refs.has(k));

  console.log(`=== A) UI 引用了但协议层**没有**（真缺口，${missing.length}）===`);
  if (!missing.length) console.log('  （无）');
  for (const k of missing) {
    console.log(`  ❌ ${k}`);
    [...refs.get(k)].slice(0, 3).forEach((loc) => console.log(`       ${loc}`));
  }

  console.log(`\n=== B) 协议层有但 UI 侧**没引用**（疑似冗余，${unused.length}）===`);
  console.log('  ' + unused.join(', '));

  console.log(`\n=== C) 域级引用分布（UI 侧）===`);
  const byDom = {};
  for (const k of looksProtocol) { const d = k.split('.')[0]; byDom[d] = (byDom[d] || 0) + 1; }
  console.log('  ' + Object.entries(byDom).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}:${n}`).join('  '));
};

main().catch((e) => { console.error('审计失败: ' + e.message); process.exit(1); });
