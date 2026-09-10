/**
 * context-chain-contributions.ts —— 上下文/压缩链贡献批（行数收尾第六批）。
 *
 * 迁移「压缩链」4 类：TokenCounter → StructuredSummarizer → CompressorOrchestrator
 * （依赖链经 needs 表达，拓扑保证顺序）+ LayeredContextComposer（contextComposer
 * 本体创建，与 tokenCounter 同属 context 域）。
 *
 * channelRegistry / modelRouter 因通道接线（buildFromLegacy/initializeChannels/
 * setMainProvider/角色通道 upsert）与 config 深度交织，暂留 factory（modelRouter
 * 依赖 channelRegistry，待后续「通道接线抽离」后一并迁移）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { LayeredContextComposer } from '../context/composer.js';
import { TokenCounter } from '../context/tokenizer.js';
import { CompressorOrchestrator, StructuredSummarizer } from '../context/compressor.js';
import type { ModelRouter } from '../provider/model-router.js';

export interface ContextChainContributionDeps {
  effectiveMaxContext: number;
  modelRouter: ModelRouter;
  compressThreshold: number | undefined;
  compressDepth: number | undefined;
}

/** 执行上下文/压缩链贡献批（contextComposer/tokenCounter/summarizer/compressor） */
export async function runContextChainContributions(
  deps: ContextChainContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  runner.provide('effectiveMaxContext', deps.effectiveMaxContext);
  runner.provide('modelRouter', deps.modelRouter);
  runner.provide('compressThreshold', deps.compressThreshold);
  runner.provide('compressDepth', deps.compressDepth);
  return runner.run([
    {
      id: 'contextComposer',
      needs: ['effectiveMaxContext'],
      provides: ['contextComposer'],
      mount: ({ effectiveMaxContext }) => ({
        contextComposer: new LayeredContextComposer(effectiveMaxContext as number),
      }),
    },
    {
      id: 'tokenCounter',
      needs: [],
      provides: ['tokenCounter'],
      mount: () => ({ tokenCounter: new TokenCounter() }),
    },
    {
      id: 'summarizer',
      needs: ['modelRouter'],
      provides: ['summarizer'],
      mount: ({ modelRouter }) => ({
        summarizer: new StructuredSummarizer(modelRouter as ModelRouter),
      }),
    },
    {
      id: 'compressor',
      needs: ['tokenCounter', 'summarizer', 'effectiveMaxContext', 'compressThreshold', 'compressDepth'],
      provides: ['compressor'],
      mount: (d) => ({
        compressor: new CompressorOrchestrator(
          d.tokenCounter as TokenCounter,
          d.summarizer as StructuredSummarizer,
          d.effectiveMaxContext as number,
          {
            compressThreshold: d.compressThreshold as number | undefined,
            compressDepth: d.compressDepth as number | undefined,
          },
        ),
      }),
    },
  ]);
}
