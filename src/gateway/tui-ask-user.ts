/**
 * tui-ask-user.ts —— Ask User 表单模块（tui.ts 深拆第三批）。
 *
 * 从 runTui 闭包迁出 AskUser 表单族（renderAskUserForm/resolveAskUser/
 * askUserState + 表单激活期的全键盘导航消费）。依赖经工厂参数注入：
 * tui（渲染）、chatLog（提交提示输出）、askUserContent/askUserBar
 * （表单主体与导航条 Text，由调用方创建并挂载 root）、protocolSend
 * （message.askUserResolve 协议回传）。
 *
 * 行为零变更：tab 切换/选项导航/空格勾选（单选互斥）/自定义输入缓存/
 * Enter 提交/Escape 取消（id 走协议空答案 '{}'，本地走 resolve('{}')）
 * 语义全部保留。表单激活时所有按键均被消费——handleKey 只执行动作，
 * 是否消费由调用方以 hasPending() 判定后统一 return { consume: true }。
 */

import { Key, matchesKey } from '@earendil-works/pi-tui';
import type { Text, TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';

/** 表单问题描述（协议层 message.ask_user 的 questions 元素同构） */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
  customInput?: boolean;
}

/** 表单内部状态（闭包私有） */
interface AskUserFormState {
  /** 协议层 ask_user 请求 id（本地直驱为空，提交走本地 resolve；协议事件非空，提交走 message.askUserResolve） */
  id?: string;
  questions: AskUserQuestion[];
  selectedOptions: Map<number, Set<number>>; // question index → selected option indices
  customTexts: Map<number, string>;           // question index → custom text
  activeQuestion: number; // 0..questions.length (questions.length = "补充" tab)
  activeOption: number;   // within current question's options
  resolve: (result: string) => void;
}

/** AskUser 模块的最小依赖面（结构化类型，便于测试替换） */
export interface TuiAskUserDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  /** 表单主体 Text（root 布局中，由调用方创建并挂载） */
  askUserContent: Text;
  /** 表单导航条 Text（root 布局中，由调用方创建并挂载） */
  askUserBar: Text;
  /** 协议回传：message.askUserResolve */
  protocolSend: (method: string, params?: unknown) => Promise<unknown>;
}

/** open() 可选参数：协议请求 id 与本地 resolve 回调 */
export interface AskUserOpenOptions {
  /** 协议层 ask_user 请求 id（存在则提交走协议，否则走本地 resolve） */
  id?: string;
  /** 本地 resolve 回调（id 缺省时提交答案） */
  resolve?: (answer: string) => void;
}

/** 创建 Ask User 表单控制器（状态与渲染封装在闭包内） */
export function createTuiAskUser(deps: TuiAskUserDeps) {
  const { tui, chatLog, askUserContent, askUserBar, protocolSend } = deps;
  let askUserState: AskUserFormState | null = null;

  function renderAskUserForm() {
    if (!askUserState) {
      askUserContent.setText('');
      askUserBar.setText('');
      return;
    }
    const { questions, selectedOptions, customTexts, activeQuestion } = askUserState;
    const supplementIdx = questions.length;
    const totalTabs = supplementIdx + 1;

    // 构建标签行
    let tabLine = '';
    for (let i = 0; i < questions.length; i++) {
      const isActive = i === activeQuestion;
      const header = questions[i].header || `问题${i + 1}`;
      tabLine += isActive ? ` ${theme.fg(`[${header}]`)} ` : ` ${theme.dim(header)}  `;
    }
    tabLine += activeQuestion === supplementIdx
      ? ` ${theme.fg('[补充]')} `
      : ` ${theme.dim('补充')}  `;

    // 构建内容
    let content = theme.warning('┌ Ask User ──────────────────────────────────────────') + '\n';
    content += tabLine + '\n';
    content += theme.warning('├────────────────────────────────────────────────────────') + '\n';

    if (activeQuestion < supplementIdx) {
      // 普通问题
      const q = questions[activeQuestion]!;
      content += `${q.question}\n\n`;
      const opts = q.options ?? [];
      const sel = selectedOptions.get(activeQuestion) ?? new Set<number>();
      const isMulti = q.multiSelect ?? false;
      for (let i = 0; i < opts.length; i++) {
        const selected = sel.has(i);
        const bullet = isMulti
          ? (selected ? theme.fg('◉') : '○')
          : (selected ? theme.fg('●') : '○');
        const highlight = i === askUserState.activeOption;
        content += (highlight ? theme.fg(` ${bullet} ${opts[i]}`) : theme.dim(` ${bullet} ${opts[i]}`)) + '\n';
      }
      // 自定义输入
      if (q.customInput ?? false) {
        const custom = customTexts.get(activeQuestion) ?? '';
        content += `\n${theme.dim('自定义:')} ${custom}${theme.dim('▌')}\n`;
      }
    } else {
      // "补充" tab
      const custom = customTexts.get(supplementIdx) ?? '';
      content += `${theme.fg('补充说明（自由输入，按 Enter 提交全部）')}\n\n`;
      content += `${custom}${theme.dim('▌')}\n`;
    }

    content += theme.warning('└────────────────────────────────────────────────────────');
    askUserContent.setText(content);

    // 导航栏
    const currentLabel = activeQuestion < supplementIdx
      ? (questions[activeQuestion]!.header || `问题${activeQuestion + 1}`)
      : '补充';
    const nav = activeQuestion < supplementIdx
      ? theme.warning(`←→ 切换  ↑↓ 选项  空格 选中  ⏎ ${currentLabel === '补充' ? '提交' : '确认'}`)
      : theme.warning(`←→ 切换  ⏎ 提交全部答案`);
    askUserBar.setText(nav);
  }

  function resolveAskUser() {
    if (!askUserState) return;
    const { questions, selectedOptions, customTexts, resolve } = askUserState;
    const suppIdx = questions.length;

    const result: Record<string, string[]> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const answers: string[] = [];

      // 选中的选项
      const sel = selectedOptions.get(i) ?? new Set<number>();
      for (const idx of sel) {
        if (q.options && q.options[idx]) {
          answers.push(q.options[idx]!);
        }
      }

      // 自定义输入
      const custom = customTexts.get(i) ?? '';
      if (custom.trim()) {
        answers.push(custom.trim());
      }

      // 用问题原文作为 key（长上下文里比 "0" "1" 更有语义）
      if (answers.length > 0) {
        result[q.question] = answers;
      }
    }

    // "补充" 输入
    const suppText = customTexts.get(suppIdx) ?? '';
    if (suppText.trim()) {
      result['补充说明'] = [suppText.trim()];
    }

    askUserContent.setText('');
    askUserBar.setText('');
    const answeredCount = Object.keys(result).length;
    chatLog.addSystem(theme.success(`◆ Answered ${answeredCount} question(s)`));
    const answer = JSON.stringify(result, null, 2);
    const qid = askUserState.id;
    askUserState = null;
    if (qid) {
      void protocolSend('message.askUserResolve', { id: qid, answer });
    } else {
      resolve(answer);
    }
    tui.requestRender();
  }

  /** 打开表单（本地直驱与协议事件共用入口） */
  function open(questions: AskUserQuestion[], opts: AskUserOpenOptions = {}): void {
    const selectedOptions = new Map<number, Set<number>>();
    const customTexts = new Map<number, string>();
    for (let i = 0; i < questions.length; i++) {
      selectedOptions.set(i, new Set());
      customTexts.set(i, '');
    }
    // "补充" tab custom text
    customTexts.set(questions.length, '');

    askUserState = {
      id: opts.id,
      questions,
      selectedOptions,
      customTexts,
      activeQuestion: 0,
      activeOption: 0,
      resolve: opts.resolve ?? (() => {}),
    };
    renderAskUserForm();
    tui.requestRender();
  }

  /**
   * 表单激活期的按键处理（所有键均被消费，本方法只执行动作）。
   * data 类型与 pi-tui matchesKey 首参一致（调用方透传监听器 data）。
   */
  function handleKey(data: Parameters<typeof matchesKey>[0]): void {
    if (!askUserState) return;
    const st = askUserState;
    const suppIdx = st.questions.length;
    const totalTabs = suppIdx + 1;
    const currentQ = st.activeQuestion < suppIdx ? st.questions[st.activeQuestion] : null;
    const opts = currentQ?.options ?? [];
    const isMulti = currentQ?.multiSelect ?? false;

    // Enter: submit（"补充" tab 或聚焦自定义输入时同样提交全部）
    if (matchesKey(data, Key.enter)) {
      // 收集当前活动的自定义输入
      const editIdx = st.activeQuestion;
      const currentCustom = st.customTexts.get(editIdx) ?? '';
      if (currentCustom.trim()) {
        st.customTexts.set(editIdx, currentCustom.trim());
      }
      resolveAskUser();
      return;
    }

    // Escape: cancel（丢弃表单）
    if (matchesKey(data, Key.escape)) {
      askUserContent.setText('');
      askUserBar.setText('');
      if (st.id) {
        void protocolSend('message.askUserResolve', { id: st.id, answer: '{}' });
      } else {
        st.resolve('{}');
      }
      askUserState = null;
      tui.requestRender();
      return;
    }

    // Left/Right: switch tabs
    if (matchesKey(data, Key.left)) {
      st.activeQuestion = (st.activeQuestion + totalTabs - 1) % totalTabs;
      st.activeOption = 0;
      renderAskUserForm();
      tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right)) {
      st.activeQuestion = (st.activeQuestion + 1) % totalTabs;
      st.activeOption = 0;
      renderAskUserForm();
      tui.requestRender();
      return;
    }

    // Up/Down: navigate options（仅问题 tab 且有选项时）
    if (st.activeQuestion < suppIdx && opts.length > 0) {
      if (matchesKey(data, Key.up)) {
        st.activeOption = (st.activeOption + opts.length - 1) % opts.length;
        renderAskUserForm();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        st.activeOption = (st.activeOption + 1) % opts.length;
        renderAskUserForm();
        tui.requestRender();
        return;
      }
    }

    // Space: toggle checkbox（单选时互斥清除其它）
    if (matchesKey(data, Key.space)) {
      if (st.activeQuestion < suppIdx && opts.length > 0) {
        const sel = st.selectedOptions.get(st.activeQuestion) ?? new Set<number>();
        if (sel.has(st.activeOption)) {
          sel.delete(st.activeOption); // 取消选中
        } else {
          if (isMulti) {
            sel.add(st.activeOption);
          } else {
            // 单选：清除其它，只选中当前
            sel.clear();
            sel.add(st.activeOption);
          }
        }
        st.selectedOptions.set(st.activeQuestion, sel);
      }
      renderAskUserForm();
      tui.requestRender();
      return;
    }

    // Backspace: delete last char in custom text
    if (matchesKey(data, Key.backspace)) {
      const editIdx = st.activeQuestion;
      const current = st.customTexts.get(editIdx) ?? '';
      st.customTexts.set(editIdx, current.slice(0, -1));
      renderAskUserForm();
      tui.requestRender();
      return;
    }

    // Typing characters → add to current tab's custom text buffer
    // data is a string; printable chars have length 1 and are not control chars
    if (typeof data === 'string' && data.length === 1 && data.charCodeAt(0) >= 32) {
      const editIdx = st.activeQuestion;
      const current = st.customTexts.get(editIdx) ?? '';
      st.customTexts.set(editIdx, current + data);
      renderAskUserForm();
      tui.requestRender();
    }
    // 其余按键一律静默（激活期全消费，由调用方兜底）
  }

  return {
    /** 是否有进行中的表单 */
    hasPending: (): boolean => askUserState !== null,
    /** 打开表单（本地直驱或协议事件） */
    open,
    /** 表单激活期的按键处理（无返回值，消费判定归调用方） */
    handleKey,
  };
}

export type TuiAskUser = ReturnType<typeof createTuiAskUser>;
