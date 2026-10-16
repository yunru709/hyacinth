'use strict';
// 渲染进程只被暴露这一小块能力。
// 现状：前端走 ui-protocol(WS) 已经能拿到全部后端能力，这里仅提供"我正跑在桌面壳里"
// 的探测点（以后前端可据此隐藏"在浏览器打开"之类的提示 / 启用原生拖拽标题栏）。
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('hyacinthDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
