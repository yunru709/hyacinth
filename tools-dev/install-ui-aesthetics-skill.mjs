// tools-dev/install-ui-aesthetics-skill.mjs —— 安装 ui-aesthetics skill（**合订版**，已被原生形态取代 ⚠️）
//
// ⚠️ 2026-09-20 起：框架已**原生支持「文件夹式 skill」**（`<name>/SKILL.md` ＋ 子文件 ✓，
//    见 `src/skills/loader.ts` 与 `docs/user-guide.md` 的「自定义技能」一节 ✓）
//    ⇒ 本脚本的"合订成一个 .md"做法**不再必要** ✓（当时是为绕开"只认平铺 .md"的限制 ✗）。
//    本脚本**保留**作为两样东西的配方 ✓：① 从**被墙的 GitHub** 抓 skill（镜像 gh-proxy.com ✓）
//    ② 抓取清单与体积核对 ✓。安装现行形态请按 user-guide 的文件夹布局直接拷贝 ✓。
//
// 为什么是"合订"而不是原样搬目录 ✗（依据：读源码得到 ✓，非推测）：
//   · 本机加载器 `src/skills/loader.ts` 的 `scanSkillsDir` ＋ `skill-watcher.ts:71`
//     只扫 `~/.agent/skills/*.md`（`filename.endsWith('.md')`）⇒ **不支持子目录** ✗
//   · skill 名取自文件名（`filename.replace(/\.md$/, '')` ✓）
//   · 原仓库是「SKILL.md ＋ 细节文件 ×12」，正文里有 "Read `…/x.md`" 的路由指令 ✗
//     ⇒ 若原样只放 SKILL.md，那些指令会指向**不存在的文件** ✗
//     ⇒ 也**不能**把细节文件平铺进 skills/ 目录 ✗（会被当成 12 个独立 skill 加载 ✗）
//   ⇒ 正确做法：**正文与附录里的路由全部改写为"见文末附录"** ✓
//
// ⚠️ 上一版自检踩坑（记录 ✓）：拿"全文不得出现细节文件名"当负向断言 ⇒ **被我自己的头部说明
//    和附录互引命中** ✗ ⇒ 假红 ✓（同族坑第 ⑪ 条：负向断言不能拿"新文案自身的子串"当锚 ✗）
//    ⇒ 本版：① 改写覆盖**全文**（含附录互引 ✓）② 负向断言**只扫头部之后的部分** ✓
//
// 来源：https://github.com/kasonye/ui-aesthetics-skill（经 gh-proxy.com 镜像抓取 ✓ —— 本机直连 GitHub 不通 ✗）
// ⚠️ 该仓库**没有 LICENSE 文件**（LICENSE 请求 404 ✓）⇒ 仅作个人自用 ✓，勿再分发 ✗
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const SRC = path.join(process.env.TEMP || '.', 'ui-aes');
const OUT = path.join(HOME, '.agent', 'skills', 'ui-aesthetics.md');
const REFKEEP = path.join(HOME, '.agent', 'references', 'ui-aesthetics');
const REFS = [
  'design-principles', 'color-system', 'component-aesthetics', 'interaction-states',
  'motion-principles', 'motion-patterns', 'depth-lighting-system', 'style-archetypes',
  'anti-patterns', 'review-rubric', 'rewrite-playbook', 'distilled-examples',
];

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
/** 把任何形态的路由（references/x.md（含变体路径））改写成"见文末附录" ✓ */
function rewriteRoutes(text) {
  let n = 0;
  const out = text.replace(/(?:[\w./-]*\/)?(?:references|ref)\/([a-z][a-z0-9-]*)\.md/g, (_m, name) => {
    n++;
    return REFS.includes(name) ? '附录「' + name + '」（见本文件末尾）' : '附录（见本文件末尾）';
  });
  return { out, n };
}

// ── ① 源 SKILL.md：拆 frontmatter / 正文 ──
const raw = read(path.join(SRC, 'SKILL.md'));
const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
if (!fm) { console.error('✗ 源 SKILL.md 没有 frontmatter ⇒ 中止'); process.exit(1); }
const srcDesc = (fm[1].match(/^description:\s*([\s\S]*)$/m) || [])[1] || '';
if (!srcDesc) { console.error('✗ 源 frontmatter 缺 description ⇒ 中止'); process.exit(1); }
const bodyR = rewriteRoutes(raw.slice(fm[0].length).trim());

// ── ② 12 个附录（同样改写互引 ✓）──
const appends = [];
let appendRoutes = 0;
for (const r of REFS) {
  const p = path.join(SRC, 'references', r + '.md');
  if (!fs.existsSync(p)) { console.error('✗ 缺文件：' + r + ' ⇒ 中止，未写盘'); process.exit(1); }
  const rr = rewriteRoutes(read(p).trim());
  appendRoutes += rr.n;
  appends.push({ name: r, text: rr.out });
}

// ── ③ 合订 ──
const header = [
  '---',
  'name: ui-aesthetics',
  'description: ' + srcDesc.trim(),
  'tools: read,write,edit,glob,grep',
  '---',
  '',
  '<!-- 安装说明（给日后维护的 agent 看 ✓）：',
  '     本文件是**合订版** —— 上游仓库（github.com/kasonye/ui-aesthetics-skill）把细节拆成多个子文件，',
  '     而本机 skill 加载器只认平铺 .md（src/skills/loader.ts ＋ skill-watcher.ts:71）✗，',
  '     故已把 12 个细节文件**全量内联**为文末附录，并把正文与附录里的路由指令一律改写为"见文末附录" ✓。',
  '     另：上游仓库**无 LICENSE**（请求 404 ✓）⇒ 仅个人自用 ✓。',
  '     安装日期 2026-09-20；抓取走 gh-proxy.com 镜像（本机直连 GitHub 不通 ✗）。 -->',
  '',
].join('\n');

const appendixText = appends.map((a) => '\n\n---\n\n## 附录 · ' + a.name + '\n\n' + a.text + '\n').join('');
const out = header + bodyR.out + '\n\n---\n\n# 附录（上游细节文件全量内联 ✓）\n' + appendixText;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

// ── ④ 另存"原始抓取物"备查（放 references/ 下 ⇒ 不会被当 skill 加载 ✓）──
fs.mkdirSync(REFKEEP, { recursive: true });
fs.copyFileSync(path.join(SRC, 'SKILL.md'), path.join(REFKEEP, 'SKILL.md'));
for (const r of REFS) fs.copyFileSync(path.join(SRC, 'references', r + '.md'), path.join(REFKEEP, r + '.md'));

// ── ⑤ 写后自检（负向断言只扫"头部之后" ✓ —— 不拿自己的说明文字当锚 ✗）──
const back = read(OUT);
const afterHeader = back.slice(header.length);
const leftover = afterHeader.match(/[\w./-]*\/[a-z][a-z0-9-]*\.md/g) || [];
const checks = [
  ['frontmatter 头', back.startsWith('---\nname: ui-aesthetics\n')],
  ['tools 字段', back.includes('tools: read,write,edit,glob,grep')],
  ['附录齐全 12 个', REFS.every((r) => back.includes('## 附录 · ' + r))],
  ['正文主体在（抽样）', back.includes('# UI Aesthetics') && back.includes('Non-Negotiables')],
  ['头部之后无残留路由（✗=0）', leftover.length === 0],
];
let bad = 0;
for (const [what, ok] of checks) { if (!ok) { console.error('✗ 自检未过：' + what); bad++; } }
if (leftover.length) console.error('   残留样本：' + leftover.slice(0, 5).join(' / '));
console.log('  路由改写：正文 ' + bodyR.n + ' 处 ＋ 附录 ' + appendRoutes + ' 处');
console.log('  体积：' + Math.round(Buffer.byteLength(out, 'utf8') / 1024) + ' KB（正文 ' +
  Math.round(Buffer.byteLength(header + bodyR.out, 'utf8') / 1024) + ' KB ＋ 附录 ' +
  Math.round(Buffer.byteLength(appendixText, 'utf8') / 1024) + ' KB）');
console.log(bad ? '✗ 自检失败（已写盘，需人工修）' : '✓ 写后自检通过（' + checks.length + ' 项）');
process.exit(bad ? 1 : 0);
