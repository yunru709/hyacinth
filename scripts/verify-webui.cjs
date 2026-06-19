const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://localhost:3100';
const OUT_DIR = path.join(process.cwd(), '.trae', 'specs', 'browser-driven-webui-ux-redesign', 'screenshots');

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];

function log(msg) {
  console.log(msg);
  results.push(msg);
}

async function screenshot(page, name, fullPage = false) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  log(`📸 screenshot: ${file}`);
  return file;
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    log(`▶ navigate ${BASE}`);
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await wait(2500);
    await screenshot(page, '01-initial');

    const hasInitError = (await page.locator('text=初始化失败').count()) > 0;
    const hasConnectionBar = (await page.locator('text=连接断开').count()) > 0;
    const hasInitIndicator = (await page.locator('text=正在初始化 Agent').count()) > 0;
    log(`  init error card: ${hasInitError}`);
    log(`  connection bar: ${hasConnectionBar}`);
    log(`  init indicator: ${hasInitIndicator}`);

    const railButtons = [
      { label: '会话', file: '02-rail-sessions' },
      { label: '模型', file: '03-rail-model' },
      { label: '上下文', file: '04-rail-context' },
      { label: '知识库', file: '05-rail-knowledge' },
      { label: '调度', file: '06-rail-scheduler' },
      { label: '设置', file: '07-rail-settings' },
    ];

    for (const btn of railButtons) {
      try {
        const locator = page.getByRole('button', { name: btn.label, exact: true });
        await locator.first().click({ timeout: 5000 });
        await wait(1000);
        await screenshot(page, btn.file);
        log(`  ✅ opened ${btn.label}`);
      } catch (e) {
        log(`  ❌ failed to open ${btn.label}: ${e.message}`);
      }
    }

    try {
      await page.keyboard.press('Control+k');
      await wait(1000);
      await screenshot(page, '08-command-palette');
      log('  ✅ command palette opened');
      await page.keyboard.press('Escape');
      await wait(300);
    } catch (e) {
      log(`  ❌ command palette failed: ${e.message}`);
    }

    try {
