import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // 测试隔离：把会话根目录重定向到临时目录（否则测试会在用户真实
    // ~/.agent/sessions 下建会话目录 —— 实测每次全量跑都会新增裸日期目录，长期成垃圾）
    setupFiles: ['src/test-setup.ts'],
    // 全量并发满载时慢文件（model-catalog-loader 黄金主测试单跑 ~21s）偶发超时
    // 放宽到 60s：超时窗口是给「满载慢」留余量，不是逻辑超时（de-flake，报告 P1）
    testTimeout: 60000,
  },
});
