import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 打开 WebUI
  await page.goto('http://localhost:3100');
  await page.waitForTimeout(3000);
  
  // 获取当前 session ID
  const sessionId1 = await page.evaluate(() => {
    return window.__DEEPTHINK_STORE__?.getState?.()?.sessionId;
  });
  console.log('初始 session ID:', sessionId1);
  
  // 发送一条消息
  await page.fill('textarea', '你好，这是第一个 session 的测试消息');
  await page.click('button[title="发送"]');
  await page.waitForTimeout(2000);
  
  // 创建新 session
  await page.click('button:has-text("新建会话")');
  await page.waitForTimeout(2000);
  
  const sessionId2 = await page.evaluate(() => {
    return window.__DEEPTHINK_STORE__?.getState?.()?.sessionId;
  });
  console.log('新 session ID:', sessionId2);
  
  // 发送第二条消息
  await page.fill('textarea', '你好，这是第二个 session 的测试消息');
  await page.click('button[title="发送"]');
  await page.waitForTimeout(2000);
  
  // 切换回第一个 session
  const sessions = await page.evaluate(() => {
    return window.__DEEPTHINK_STORE__?.getState?.()?.sessions || [];
  });
  console.log('所有 sessions:', sessions.map(s => s.id));
  
  if (sessions.length >= 2) {
    const firstSessionId = sessions[0].id;
    await page.click(`text=${firstSessionId.slice(0, 10)}`);
    await page.waitForTimeout(2000);
    
    const currentSessionId = await page.evaluate(() => {
      return window.__DEEPTHINK_STORE__?.getState?.()?.sessionId;
    });
    console.log('切换后的 session ID:', currentSessionId);
    
    // 检查消息历史是否加载
    const messages = await page.evaluate(() => {
      const state = window.__DEEPTHINK_STORE__?.getState?.();
      return state?.messages || [];
    });
    console.log('加载的消息数量:', messages.length);
    
    if (messages.length > 0) {
      console.log('✓ Session 切换成功，历史消息已加载');
    } else {
      console.log('✗ Session 切换失败，历史消息未加载');
    }
  }
  
  await browser.close();
})();
