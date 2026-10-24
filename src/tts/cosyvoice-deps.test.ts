// cosyvoice-deps 单测：纯函数面（仓库解析/PYTHONPATH 合成/推理裁剪集）。
// 安装流程本身（git/pip 子进程）不做单测 —— 真机验证路径。
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  cosyvoiceRepoDir,
  cosyvoiceRepoPresent,
  cosyvoicePythonEnv,
  INFERENCE_REQUIREMENTS,
  ensureCosyVoiceDeps,
} from './cosyvoice-deps.js';

const ORIG_REPO_ENV = process.env.HYACINTH_COSYVOICE_REPO;
const ORIG_PYTHONPATH = process.env.PYTHONPATH;

describe('cosyvoice-deps 纯函数', () => {
  afterEach(() => {
    if (ORIG_REPO_ENV === undefined) delete process.env.HYACINTH_COSYVOICE_REPO;
    else process.env.HYACINTH_COSYVOICE_REPO = ORIG_REPO_ENV;
    if (ORIG_PYTHONPATH === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = ORIG_PYTHONPATH;
  });

  it('仓库目录：env HYACINTH_COSYVOICE_REPO 优先于默认 ~/.agent/envs/CosyVoice', () => {
    delete process.env.HYACINTH_COSYVOICE_REPO;
    expect(cosyvoiceRepoDir()).toBe(path.join(os.homedir(), '.agent', 'envs', 'CosyVoice'));
    process.env.HYACINTH_COSYVOICE_REPO = 'D:\\voice\\CosyVoice';
    expect(cosyvoiceRepoDir()).toBe('D:\\voice\\CosyVoice');
  });

  it('PYTHONPATH 合成：仓库根前置、保留已有值（spawn 与探测同环境）', () => {
    delete process.env.PYTHONPATH;
    const env1 = cosyvoicePythonEnv();
    expect(String(env1.PYTHONPATH).split(path.delimiter)).toEqual([
      cosyvoiceRepoDir(),
      path.join(cosyvoiceRepoDir(), 'third_party', 'Matcha-TTS'),
    ]);
    process.env.PYTHONPATH = 'C:\\other\\libs';
    const env2 = cosyvoicePythonEnv();
    expect(String(env2.PYTHONPATH).split(path.delimiter)).toEqual([
      cosyvoiceRepoDir(),
      path.join(cosyvoiceRepoDir(), 'third_party', 'Matcha-TTS'),
      'C:\\other\\libs',
    ]);
  });

  it('推理裁剪集：不含 torch/torchaudio/numpy/训练与 web 依赖（保护用户已装 torch）', () => {
    // lightning 是 matcha flow 组件的运行依赖（非训练专用），在清单里
    const banned = ['torch', 'torchaudio', 'numpy', 'deepspeed', 'tensorboard',
      'gradio', 'fastapi', 'grpcio', 'matplotlib', 'tensorrt'];
    for (const req of INFERENCE_REQUIREMENTS) {
      const pkg = req.split(/[=<>!]/)[0].toLowerCase();
      expect(banned).not.toContain(pkg);
    }
    // 推理链关键包在清单里
    for (const need of ['HyperPyYAML', 'transformers', 'onnxruntime', 'librosa', 'wetext', 'x-transformers']) {
      expect(INFERENCE_REQUIREMENTS.some((r) => r.toLowerCase().startsWith(need.toLowerCase()))).toBe(true);
    }
  });

  it('cosyvoiceRepoPresent：目录不存在返回 false（不抛错）', () => {
    process.env.HYACINTH_COSYVOICE_REPO = 'Z:\\definitely\\not\\exist';
    expect(cosyvoiceRepoPresent()).toBe(false);
  });
});
