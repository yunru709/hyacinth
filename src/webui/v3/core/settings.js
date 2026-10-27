/* ══════════════════════════════════════════════════════════════════════════
   设置页 schema —— 数据驱动，三套设计语言共用
   ══════════════════════════════════════════════════════════════════════════

   为什么是 schema 而不是三份设置页：
     v1 的设置页覆盖 30+ 配置项。若 tui / editorial / classic 各写一份表单，
     就是三倍代码、三倍布局 bug，且加一个新配置项要改三处。
     改成 schema 后：**加配置项只改这个文件**，三套语言自动获得。

   各语言的义务只有一条：
     renderForm(group, container) —— 把 items 画成自己的控件
     控件的**样式与摆放**由各语言决定（TUI 是等宽列表，classic 是圆角表单）。

   ⚠️ 所有 path 都用点路径，读写一律走 app.config.get/set（内部用 `path` 参数，
      不是 `key` —— 实测传 key 会静默返回整棵树）。
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 控件类型：
 *   bool        开关
 *   range       带数值显示的滑杆（需 min/max/step）
 *   number      数字输入
 *   text        单行文本
 *   select      下拉（options 为静态数组，或 "providers" 走动态来源）
 *   action      按钮（执行某个操作，不写配置）
 */

export const SETTINGS_GROUPS = [
  {
    id: 'model',
    label: '模型与推理',
    desc: '在线 / 本地模型切换与生成参数。',
    items: [
      {
        type: 'status',
        label: '当前模型',
        hint: '请求实际发往的模型；换 Provider 后下一轮生效。',
        load: async (app) => {
          const a = await app.model.active();
          const name = a?.model || a?.providerLabel || '未知';
          return { text: name, ok: true };
        },
      },
      {
        path: 'provider.active',
        label: '当前 Provider',
        type: 'select',
        source: 'providers',
        hint: '切换后新会话生效；已有会话保留原模型。',
      },
      {
        path: 'provider.temperature',
        label: '温度',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.05,
        hint: '越高越发散，越低越确定。',
      },
      {
        path: 'provider.topP',
        label: 'Top P',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        path: 'provider.streaming',
        label: '流式输出',
        type: 'bool',
        hint: '逐字返回模型生成内容。',
      },
      {
        path: 'ui.showThinking',
        label: '显示思考过程',
        type: 'bool',
        hint: '模型内部的推理；工具与结论照常显示。',
      },
    ],
  },
  {
    id: 'context',
    label: '上下文与压缩',
    desc: '决定一轮对话能记住多少、何时压缩。',
    items: [
      {
        path: 'session.maxContext',
        label: '最大上下文 Token',
        type: 'number',
        min: 1000,
        step: 1000,
      },
      {
        path: 'session.maxTurns',
        label: '单会话最大轮次',
        type: 'number',
        min: 1,
      },
      {
        path: 'context.compressThreshold',
        label: '触发压缩的比例',
        type: 'range',
        min: 0.3,
        max: 0.99,
        step: 0.01,
        hint: '上下文占用达到该比例时开始压缩。',
      },
      {
        path: 'context.scratchpadMaxChars',
        label: '记事本字符上限',
        type: 'number',
        min: 500,
        step: 500,
        hint: '超出会被截断，但每轮仍按全文计费。',
      },
    ],
  },
  {
    id: 'tools',
    label: '工具与安全',
    desc: '工具执行限制与危险操作确认。',
    items: [
      {
        path: 'safety.requireConfirmation',
        label: '危险操作需确认',
        type: 'bool',
      },
      {
        path: 'tools.sanitize',
        label: '过滤工具输出',
        type: 'bool',
        hint: '去掉控制字符等不可见内容。',
      },
      {
        path: 'tools.bash.timeoutSec',
        label: 'bash 超时（秒）',
        type: 'number',
        min: 10,
        step: 10,
      },
      {
        path: 'tools.executor.timeoutMs',
        label: '工具执行超时（毫秒）',
        type: 'number',
        min: 1000,
        step: 1000,
      },
    ],
  },
  {
    id: 'voice',
    label: '语音',
    desc: '语音输入（STT）与语音播报（TTS）。',
    items: [
      {
        type: 'status',
        label: '语音识别模型',
        hint: '未就绪时麦克风可用，但转写会失败。',
        load: async (app) => {
          const s = await app.voice.sttStatus();
          if (!s) return { text: '状态未知', ok: false };
          return { text: s.modelReady ? '已就绪' : '未下载', ok: !!s.modelReady };
        },
      },
      {
        type: 'status',
        label: 'TTS 引擎',
        load: async (app) => {
          const s = await app.voice.ttsStatus();
          const ready = s?.model?.ready === true;
          const svc = s?.service?.running ? '服务运行中' : '服务未启动';
          return { text: ready ? `已就绪 · ${svc}` : `未就绪 · ${svc}`, ok: ready };
        },
      },
      {
        path: 'stt.enabled',
        label: '启用语音输入',
        type: 'bool',
        hint: '开启后输入区出现麦克风，录音转文字。',
      },
      {
        path: 'voice.say.broadcast',
        label: '自动朗读回复',
        type: 'bool',
        hint: '助手回复完成后直接朗读。',
      },
      {
        path: 'voice.say.voice',
        label: '朗读音色',
        type: 'text',
        hint: '音色 id，留空用引擎默认。',
      },
      {
        path: 'voice.tts.engine',
        label: 'TTS 引擎',
        type: 'select',
        source: 'ttsEngines',
      },
      {
        path: 'voice.tts.breeze.serverPort',
        label: 'breeze 服务端口',
        type: 'number',
        min: 1,
        max: 65535,
        hint: '常驻服务端口；改后需重启引擎。',
      },
      {
        path: 'voice.tts.breeze.backend',
        label: 'breeze 后端',
        type: 'select',
        options: [
          { value: 'cuda', label: 'CUDA（GPU）' },
          { value: 'cpu', label: 'CPU' },
        ],
      },
    ],
  },
  {
    id: 'ui',
    label: '外观',
    desc: '界面主题与配色。',
    items: [
      {
        path: 'ui.theme',
        label: '主题',
        type: 'select',
        source: 'palettes',
        hint: '各设计语言对"主题"的解释不同，这里只记偏好。',
      },
    ],
  },
  {
    id: 'advanced',
    label: '高级',
    desc: '日志、诊断、热重载。改动会影响运行行为。',
    items: [
      {
        path: 'logging.level',
        label: '日志级别',
        type: 'select',
        options: [
          { value: 'error', label: 'error' },
          { value: 'warn', label: 'warn' },
          { value: 'info', label: 'info' },
          { value: 'debug', label: 'debug' },
        ],
      },
      {
        path: 'diagnostics.enabled',
        label: '启用诊断',
        type: 'bool',
      },
      {
        path: 'hotReload.enabled',
        label: '热重载',
        type: 'bool',
        hint: '改动提示词 / 工具 / 技能时自动生效。',
      },
    ],
  },
];

/* ═══ 读取与写入 ═════════════════════════════════════════════════════════ */

/** 从点路径取值。 */
export function readPath(tree, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), tree);
}

/**
 * 读出所有设置项的当前值 → { 'provider.temperature': 0.7, ... }
 * 只读一次 getAll，避免 N 个字段发 N 个请求。
 */
export async function loadValues(app) {
  const tree = await app.config.all();
  const values = {};
  for (const g of SETTINGS_GROUPS) {
    for (const item of g.items) {
      /* ⚠️ status 项只有 type/label/load，**没有 path** ——
         若不跳过，readPath(tree, undefined) 会在 undefined 上调 .split() 直接抛错，
         整个设置页打不开（实测踩过）。 */
      if (!item.path) continue;
      values[item.path] = readPath(tree, item.path);
    }
  }
  return values;
}

/** 写一项。返回是否成功。 */
export async function saveValue(app, path, value) {
  return app.config.set(path, value);
}

/**
 * 解析动态下拉来源。
 * 语言层在渲染 select 时调用它，避免把"取列表"的逻辑写进三份 UI。
 */
export async function resolveOptions(app, item) {
  if (!item.source) return item.options ?? [];
  switch (item.source) {
    case 'providers': {
      const list = await app.model.providers();
      return list.map((p) => ({
        value: p.type,
        label: `${p.label}${p.configured ? '' : '（未配置）'}`,
      }));
    }
    case 'ttsEngines': {
      const { engines } = await app.voice.ttsEngines();
      return (engines || []).map((e) => ({
        value: e.kind || e.id,
        label: `${e.label}${e.ready ? '' : '（未就绪）'}`,
      }));
    }
    case 'palettes':
      return [
        { value: 'night', label: '夜' },
        { value: 'day', label: '日' },
        { value: 'sepia', label: '褐' },
        { value: 'mono', label: '单色' },
        { value: 'forest', label: '林' },
      ];
    default:
      return [];
  }
}
