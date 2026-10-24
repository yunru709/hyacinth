/**
 * CosyVoice python 依赖自动安装器 —— 「点击下载 = 立刻可用」的依赖半边。
 *
 * 模型下载（cosyvoice-models.ts）管权重文件；本模块管 python 生态：
 *   1. 仓库获取：CosyVoice 不是 pip 包（无 setup.py），官方用法是
 *      clone 仓库 + PYTHONPATH 指向仓库根 —— clone 到 ~/.agent/envs/CosyVoice
 *      （env HYACINTH_COSYVOICE_REPO 可覆盖位置）。
 *   2. 依赖安装：官方 requirements.txt 把 torch 钉死 2.3.1，会把用户
 *      已装的 torch（如 2.6 cu124）降级重装 —— 这里用**推理裁剪集**
 *      （只装推理链需要的包，不碰 torch/torchaudio/numpy 版本）。
 *   3. 幂等：每次先做导入探测（带 PYTHONPATH 的 python -c import），
 *      通过即零安装；装完复检，失败带 pip 日志尾部抛错。
 *
 * pip 装到用户全局 python —— 与「外来环境按需安装」的设计一致：
 * 入口在设置页（tts.download 一键流程），源码不携带这些环境。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** CosyVoice 仓库根（env 覆盖 > ~/.agent/envs/CosyVoice） */
export function cosyvoiceRepoDir(): string {
  const fromEnv = process.env.HYACINTH_COSYVOICE_REPO;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.agent', 'envs', 'CosyVoice');
}

/** 仓库是否已就位（cli 包存在即算） */
export function cosyvoiceRepoPresent(): boolean {
  try {
    return fs.existsSync(path.join(cosyvoiceRepoDir(), 'cosyvoice', 'cli', 'cosyvoice.py'));
  } catch { return false; }
}

/** matcha 子模块包是否拉全（flow_matching 依赖它，缺了模型加载必挂） */
function matchaPresent(): boolean {
  try {
    return fs.existsSync(path.join(cosyvoiceRepoDir(), 'third_party', 'Matcha-TTS', 'matcha', 'models'));
  } catch { return false; }
}

/**
 * 子模块修复：`--depth 1 --filter=blob:none` 的浅克隆下
 * `git submodule update` 可能找不到记录 revision（实测）—— 先试标准
 * 命令，仍缺则按 gitlink sha 手动 clone + checkout。
 */
async function ensureMatchaSubmodule(say: DepsProgress): Promise<void> {
  if (matchaPresent()) return;
  const repo = cosyvoiceRepoDir();
  say('拉取 Matcha-TTS 子模块（flow 组件依赖）…');
  await run('git', ['-C', repo, 'submodule', 'update', '--init', '--recursive'], {}).catch(() => null);
  if (matchaPresent()) return;
  // 兜底：读 gitlink sha 手动 clone
  const ls = await run('git', ['-C', repo, 'ls-tree', 'HEAD', 'third_party/Matcha-TTS'], {});
  const sha = ls.tail.join(' ').split(/\s+/).find((t) => /^[0-9a-f]{40}$/.test(t));
  if (!sha) throw new Error('无法解析 Matcha-TTS 子模块版本（git ls-tree 无 gitlink）');
  const subDir = path.join(repo, 'third_party', 'Matcha-TTS');
  fs.rmSync(subDir, { recursive: true, force: true });
  const clone = await run('git', ['clone', '--quiet', 'https://github.com/shivammehta25/Matcha-TTS.git', subDir], { onLine: say });
  if (clone.code !== 0) throw new Error(`Matcha-TTS 克隆失败：${clone.tail.slice(-3).join(' ')}`);
  const co = await run('git', ['-C', subDir, 'checkout', '--quiet', sha], {});
  if (co.code !== 0 || !matchaPresent()) throw new Error('Matcha-TTS checkout 失败');
}

/**
 * python 子进程环境：PYTHONPATH 前置仓库根 + Matcha-TTS 子模块（保留已有）。
 * spawn server.py 与导入探测共用 —— 保证「装好的环境」与「运行的环境」一致。
 */
export function cosyvoicePythonEnv(): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '';
  const repo = cosyvoiceRepoDir();
  return {
    ...process.env,
    PYTHONPATH: repo + path.delimiter + path.join(repo, 'third_party', 'Matcha-TTS') + existing,
  };
}

/**
 * 推理裁剪依赖集（Windows/本机推理）：官方 requirements.txt 的子集 ——
 * 去掉 torch（尊重用户已装版本，官方 pin 2.3.1 会降级破坏环境；
 * torchaudio 需与 torch 严格同版，由安装器动态匹配，见 ensureCosyVoiceDeps）、
 * numpy（librosa/onnxruntime 对 1.26+/2.x 均兼容）、训练与 web 服务依赖
 * （deepspeed/tensorboard/lightning/gradio/fastapi/grpc 等）。
 * 只保留 CosyVoice3 推理链的 import 闭包。实机踩坑沉淀：
 *   · onnxruntime>=1.19.2 —— 1.18 在 numpy 2.x 下 pybind 加载失败
 *   · openai-whisper —— frontend.py 直接 import whisper；其 setup 依赖
 *     pkg_resources，须配 setuptools<81（81+ 已移除）且 --no-build-isolation
 */
export const INFERENCE_REQUIREMENTS: readonly string[] = [
  'conformer==0.3.2',
  'diffusers==0.29.0',
  'einops',
  'gdown',
  'hydra-core==1.3.2',
  'HyperPyYAML==1.2.3',
  'inflect==7.3.1',
  'librosa==0.10.2',
  'lightning',
  'modelscope',
  'networkx<3.2',
  'omegaconf==2.3.0',
  'onnx==1.16.0',
  'onnxruntime>=1.19.2',
  'openai-whisper==20231117',
  'protobuf==4.25',
  'pyworld==0.3.4',
  'scipy',
  'setuptools<81',
  'soundfile==0.12.1',
  'transformers==4.51.3',
  'tqdm',
  'unidecode',
  'wetext==0.0.4',
  'wget',
  'x-transformers==2.11.24',
];

/** 仓库根下写的裁剪清单文件名（pip install -r 用） */
export const REQUIREMENTS_FILE = 'hyacinth-inference-requirements.txt';

/** 导入探测：from cosyvoice.cli.cosyvoice import CosyVoice3（带 PYTHONPATH） */
export function cosyvoiceImportOk(pythonPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-c', 'from cosyvoice.cli.cosyvoice import CosyVoice3'], {
      env: cosyvoicePythonEnv(),
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 进度回调：line 为 git/pip 输出行 */
export type DepsProgress = (line: string) => void;

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; onLine?: DepsProgress }): Promise<{ code: number; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, shell: process.platform === 'win32' });
    const tail: string[] = [];
    const eat = (d: Buffer) => {
      const text = String(d).trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        if (tail.length >= 30) tail.shift();
        tail.push(line);
        opts.onLine?.(line);
      }
    };
    child.stdout?.on('data', eat);
    child.stderr?.on('data', eat);
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, tail }));
  });
}

/**
 * 确保 python 依赖就绪（幂等）：
 *   导入通过 → 直接返回；否则 clone（若缺）→ pip 装裁剪集 → 复检。
 * 任一步失败抛 Error（带日志尾部），由 tts.download 编排转进度/错误事件。
 */
export async function ensureCosyVoiceDeps(opts: {
  pythonPath: string;
  onProgress?: DepsProgress;
  /** 下载源偏好（预留镜像选择；当前 github 直连） */
  mirror?: string;
}): Promise<void> {
  const { pythonPath, onProgress } = opts;
  const say = (line: string) => onProgress?.(line);

  if (await cosyvoiceImportOk(pythonPath)) return;

  // 1) 仓库就位（浅克隆 + 子模块；third_party/Matcha 是子模块）
  if (!cosyvoiceRepoPresent()) {
    say('克隆 CosyVoice 仓库（含子模块，约几十 MB）…');
    const parent = path.dirname(cosyvoiceRepoDir());
    fs.mkdirSync(parent, { recursive: true });
    const clone = await run('git', [
      'clone', '--recursive', '--quiet', '--filter=blob:none', '--depth', '1',
      'https://github.com/FunAudioLLM/CosyVoice.git', cosyvoiceRepoDir(),
    ], { onLine: say });
    if (clone.code !== 0 && !cosyvoiceRepoPresent()) {
      throw new Error(`git clone 失败：${clone.tail.slice(-5).join(' ')}`);
    }
  }
  await ensureMatchaSubmodule(say);

  // 2) torchaudio 动态匹配：与已装 torch 严格同版（pip 自动解析会拉最新
  //    torchaudio → 连带升级 torch，破坏用户 CUDA 环境）。无 torch 时一并装。
  const torchVer = await run(pythonPath, ['-c', 'import torch; print(torch.__version__)'], {})
    .then((r) => (r.code === 0 ? r.tail[r.tail.length - 1].split('+')[0].trim() : null))
    .catch(() => null);
  const torchaudioMissing = await run(pythonPath, ['-c', 'import torchaudio'], {})
    .then((r) => r.code !== 0).catch(() => true);
  if (torchaudioMissing) {
    say(torchVer ? `安装 torchaudio（匹配已装 torch ${torchVer}）…` : '安装 torch + torchaudio…');
    const at = await run(pythonPath, ['-m', 'pip', 'install', ...(torchVer ? [`torchaudio==${torchVer}`] : ['torch', 'torchaudio'])], { onLine: say });
    if (at.code !== 0) throw new Error(`torchaudio 安装失败：${at.tail.slice(-5).join(' ')}`);
  }

  // 3) pip 装推理裁剪集（写盘再 -r，避免超长命令行；幂等可重入）。
  //    --no-build-isolation：openai-whisper 的 setup 依赖 pkg_resources，
  //    隔离构建环境装的是 setuptools 81+（已移除 pkg_resources）必挂 ——
  //    用当前环境（清单里已含 setuptools<81）构建。
  const reqPath = path.join(cosyvoiceRepoDir(), REQUIREMENTS_FILE);
  fs.writeFileSync(reqPath, INFERENCE_REQUIREMENTS.join('\n') + '\n', 'utf8');
  say('安装 python 推理依赖（跳过已满足的包）…');
  const pip = await run(pythonPath, ['-m', 'pip', 'install', '-r', reqPath, '--no-build-isolation'], { onLine: say });
  if (pip.code !== 0) {
    throw new Error(`pip install 失败：${pip.tail.slice(-8).join(' | ')}`);
  }

  // 4) wetext 正则化资源（CosyVoice3 文本 frontend 硬依赖）：snapshot_download
  //    每次 API 校验、匿名限流时会挂 —— 预热一次本地缓存；成功后 server.py
  //    的离线补丁直接用缓存，运行期零网络。失败不阻断（重试点下载即可）。
  const wetextCache = path.join(os.homedir(), '.cache', 'modelscope', 'hub', 'models', 'pengzhendong', 'wetext');
  const wetextOk = () => {
    try {
      const q = path.join(wetextCache, 'zh', 'tn', 'tagger.fst');
      return fs.existsSync(q) && fs.statSync(q).size > 10_000;
    } catch { return false; }
  };
  if (!wetextOk()) {
    say('预热 wetext 文本正则化资源（约 20MB）…');
    const warm = await run(pythonPath, ['-c', "from modelscope import snapshot_download; snapshot_download('pengzhendong/wetext')"], { env: cosyvoicePythonEnv(), onLine: say });
    if (!wetextOk()) {
      say(`wetext 资源预热未完成（可稍后重试下载）：${warm.tail.slice(-2).join(' ')}`);
    }
  }

  // 5) 复检导入（而非信 pip 退出码 —— 版本冲突可能装完仍 import 失败）
  if (!(await cosyvoiceImportOk(pythonPath))) {
    const probe = await run(pythonPath, ['-c', 'from cosyvoice.cli.cosyvoice import CosyVoice3'], { env: cosyvoicePythonEnv() });
    throw new Error(`依赖装完仍无法导入 cosyvoice：${probe.tail.slice(-5).join(' | ')}`);
  }
  say('python 依赖就绪');
}
