import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // 全量并发满载时慢文件（model-catalog-loader 黄金主测试单跑 ~21s）偶发超时
    // 放宽到 60s：超时窗口是给「满载慢」留余量，不是逻辑超时（de-flake，报告 P1）
    testTimeout: 60000,
  },
});
