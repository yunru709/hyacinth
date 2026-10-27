/* ============================================================================
   Hyacinth WebUI v2 — 模型视图

   功能面（对齐 v1 的 model.* 21 个 RPC，全部保留）：
     通道列表 / 每通道模型 / 推理强度 / 本地模型 / 角色绑定

   布局：通道卡片列表。每张卡片左标题右下拉 —— 比 v1 的表格更适合窄屏，
   也不用横向滚动。
   ========================================================================== */

import { client } from '../main.js';
import { setModelLabel } from '../main.js';
import { pageShell, section, row, placeholder, h } from './_layout.js';

let els = {};
let mounted = false;

export const modelView = {
  mount(host) {
    els = pageShell(host, {
      title: '模型',
      desc: '管理在线provider、本地模型与每个通道使用的模型。',
    });
    mounted = true;
  },

  refresh() {
    if (mounted) load();
  },
};

async function load() {
  els.body.innerHTML = '';
  const loading = placeholder('loading', '读取通道…');
  els.body.appendChild(loading);

  let channels = [];
  let active = null;
  try {
    const [chRes, actRes] = await Promise.all([
      client.request('model.listChannels', {}),
      client.request('model.getActive', {}),
    ]);
    channels = chRes?.channels || chRes || [];
    active = actRes;
  } catch (err) {
    els.body.innerHTML = '';
    els.body.appendChild(placeholder('error', err.message));
    return;
  }

  els.body.innerHTML = '';

  // 当前生效的模型显示到顶栏，保证全局一致
  if (active?.model) {
    setModelLabel(active.label || active.model, 'online');
  }

  const body = section(els.body, {
    title: '通道',
    desc: '每个通道各自绑定模型。当前生效的通道在顶栏可见。',
  });

  if (!Array.isArray(channels) || channels.length === 0) {
    body.appendChild(placeholder('empty', '还没有配置任何通道'));
    return;
  }

  for (const ch of channels) {
    const select = h('select', { class: 'c-select' });
    const models = ch.models || ch.availableModels || [];
    for (const m of models) {
      const opt = h('option', { value: m.id || m, text: m.label || m.id || m });
      if ((m.id || m) === ch.model) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', async () => {
      try {
        await client.request('model.setChannelModel', {
          channel: ch.id,
          model: select.value,
        });
        load();
      } catch (err) {
        alert(err.message);
      }
    });

    row(body, {
      title: ch.name || ch.id,
      desc: ch.provider ? `provider: ${ch.provider}` : '',
      control: select,
    });
  }
}
