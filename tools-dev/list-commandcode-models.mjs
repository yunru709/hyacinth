/**
 * 拉 commandcode 当前真实可用模型清单（/models），与本地目录对账。
 * 只读，不发 completion。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://api.commandcode.ai/provider/v1';

function loadKey() {
  const p = path.join(os.homedir(), '.agent', '.env');
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*COMMANDCODE_API_KEY\s*=\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('COMMANDCODE_API_KEY not found');
}
const KEY = loadKey();

for (const ep of ['/models', '/provider/v1/models']) {
  const url = `https://api.commandcode.ai${ep}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'hyacinth-probe/1.0' },
    });
    const txt = await res.text();
    console.log(`\n### GET ${url} -> ${res.status}`);
    if (res.ok) {
      try {
        const j = JSON.parse(txt);
        const list = j.data ?? j.models ?? j;
        if (Array.isArray(list)) {
          console.log(`  count=${list.length}`);
          for (const m of list) {
            const id = m.id ?? m.name ?? m.slug ?? JSON.stringify(m).slice(0, 80);
            const extra = [];
            if (m.context_length ?? m.context_window) extra.push(`ctx=${m.context_length ?? m.context_window}`);
            if (m.pricing ?? m.cost) extra.push(`pricing=${JSON.stringify(m.pricing ?? m.cost)}`);
            if (m.owned_by) extra.push(`owned_by=${m.owned_by}`);
            console.log(`  - ${id}${extra.length ? '  [' + extra.join(' ') + ']' : ''}`);
          }
        } else {
          console.log(`  shape: ${JSON.stringify(j).slice(0, 800)}`);
        }
      } catch {
        console.log(`  non-json: ${txt.slice(0, 400)}`);
      }
    } else {
      console.log(`  body: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`\n### GET ${url} -> ERROR ${e.message}`);
  }
}
