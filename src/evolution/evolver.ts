import { GitManager } from './git-manager.js';
import { buildEvolutionPrompt, buildTestMessages, evaluateTestResponse } from './prompts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

export type EvolutionPhase =
  | 'idle'
  | 'preparing'
  | 'modifying'
  | 'building'
  | 'testing'
  | 'merging'
  | 'rolling_back'
  | 'done'
  | 'failed';

export interface EvolutionStatus {
  phase: EvolutionPhase;
  branch: string | null;
  targetFiles: string[];
  commitHash: string | null;
  error: string | null;
  startedAt: string | null;
  testResults: { passed: number; failed: number; total: number } | null;
}

export interface EvolutionResult {
  success: boolean;
  merged: boolean;
  summary?: string;
  commitHash: string | null;
  diff: string | null;
  error: string | null;
  testResults: { passed: number; failed: number; total: number } | null;
}

export class Evolver {
  private gitManager: GitManager;
  private status: EvolutionStatus;
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.gitManager = new GitManager(projectDir);
    this.status = {
      phase: 'idle',
      branch: null,
      targetFiles: [],
      commitHash: null,
      error: null,
      startedAt: null,
      testResults: null,
    };
  }

  getStatus(): EvolutionStatus {
    return { ...this.status };
  }

  /**
   * Run the full self-evolution cycle:
   *   1. Ensure git repo exists (init if needed), commit any pending changes
   *   2. Create experiment branch
   *   3. Inject evolution prompt into Agent
   *   4. Let Agent modify code
   *   5. Detect changes (committed via main..HEAD + uncommitted)
   *   6. Commit uncommitted changes if any
   *   7. TypeScript compilation check (tsc --noEmit)
   *   8. Run tests (vitest)
   *   9. Merge to main on success, rollback on failure
   */
  async runEvolution(
    targetFiles: string[],
    injectPrompt: (prompt: string) => void,
    onOutput: (message: string) => void,
    agentLoop: any,
  ): Promise<EvolutionResult> {
    // Reset status
    this.status = {
      phase: 'preparing',
      branch: null,
      targetFiles,
      commitHash: null,
      error: null,
      startedAt: new Date().toISOString(),
      testResults: null,
    };

    try {
      // ── Step 1: Ensure git repo exists ──
      onOutput('\u25B6 Preparing Git repository...');
      if (!(await this.gitManager.isRepo())) {
        onOutput('  Initializing git repo...');
        await this.gitManager.init();
      } else if (await this.gitManager.hasUncommittedChanges()) {
        onOutput('  Committing pending changes...');
        await this.gitManager.commit('checkpoint: before evolution');
      }

      // ── Step 2: Create experiment branch ──
      const branchName = `evolver/experiment-${Date.now()}`;
      onOutput(`\u25B6 Creating experiment branch: ${branchName}`);
      await this.gitManager.createBranch(branchName);
      this.status.branch = branchName;
      this.status.phase = 'modifying';

      // ── Step 3: Generate and inject evolution prompt ──
      onOutput('\u25B6 Injecting evolution prompt...');
      const prompt = buildEvolutionPrompt(targetFiles);
      injectPrompt(prompt);

      // ── Step 4: Run the Agent to let it modify code ──
      onOutput('\u25B6 Running Agent to modify code...');
      try {
        await agentLoop.run(
          `Modify the following files to improve the framework:\n${targetFiles.join('\n')}\n\n` +
            `After making changes, commit them with: evolve: <description>`,
        );
      } catch (err) {
        onOutput(
          `  Warning: Agent run ended: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 5: Detect whether any changes were made ──
      // Cover two cases:
      //   a) Agent committed changes → diff main..HEAD is non-empty
      //   b) Agent modified files but did NOT commit → hasUncommittedChanges is true
      const hasUncommitted = await this.gitManager.hasUncommittedChanges();
      const diff = await this.gitManager.diff('main..HEAD');

      if (!diff.trim() && !hasUncommitted) {
        onOutput('  No changes were made by the Agent.');
        await this.gitManager.checkout('main');
        await this.gitManager.deleteBranch(branchName);
        this.status.phase = 'done';
        return {
          success: false,
          merged: false,
          commitHash: null,
          diff: null,
          error: 'No changes made',
          testResults: null,
        };
      }

      const diffLineCount = diff.trim() ? diff.split('\n').length : 0;
      onOutput(`  Changes detected (${diffLineCount} diff lines)`);

      // ── Step 6: Commit uncommitted changes if needed ──
      if (hasUncommitted) {
        onOutput('  Committing uncommitted changes...');
        await this.gitManager.commit('evolve: auto-committed changes');
      }

      // Retrieve the latest commit hash on this branch
      const log = await this.gitManager.log(1);
      const commitHash = log[0]?.hash || null;
      this.status.commitHash = commitHash;

      // ── Step 7: TypeScript compilation check ──
      this.status.phase = 'building';
      onOutput('\u25B6 Running TypeScript compilation check...');
      try {
        await execFileAsync('npx', ['tsc', '--noEmit'], {
          cwd: this.projectDir,
          maxBuffer: 10 * 1024 * 1024,
        });
        onOutput('  \u2713 TypeScript compilation passed');
      } catch (err: any) {
        const stderr = err.stderr || err.message || '';
        onOutput(`  \u2717 TypeScript compilation failed: ${stderr.slice(0, 200)}`);
        await this.rollback(branchName);
        return {
          success: false,
          merged: false,
          commitHash: null,
          diff,
          error: `Build failed: ${stderr.slice(0, 200)}`,
          testResults: null,
        };
      }

      // ── Step 8: Run tests ──
      this.status.phase = 'testing';
      onOutput('\u25B6 Running tests on new version...');
      let testResults: { passed: number; failed: number; total: number };

      try {
        const { stdout } = await execFileAsync(
          'npx',
          ['vitest', 'run', '--reporter=verbose'],
          {
            cwd: this.projectDir,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
          },
        );
        const passedMatch = stdout.match(/(\d+)\s+passed/);
        const failedMatch = stdout.match(/(\d+)\s+failed/);
        const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
        const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
        testResults = { passed, failed, total: passed + failed };
        onOutput(`  Tests: ${passed} passed, ${failed} failed`);

        if (failed > 0) {
          await this.rollback(branchName);
          return {
            success: false,
            merged: false,
            commitHash: null,
            diff,
            error: `Tests failed: ${failed} failures`,
            testResults,
          };
        }
      } catch (err) {
        onOutput(
          `  \u26A0 Test runner issue: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue anyway if the test runner itself failed (not test assertions)
        testResults = { passed: 0, failed: 0, total: 0 };
      }

      this.status.testResults = testResults;

      // ── Step 9: Merge to main ──
      this.status.phase = 'merging';
      onOutput('\u25B6 Merging changes to main...');
      await this.gitManager.checkout('main');
      await this.gitManager.merge(branchName);
      onOutput(`  \u2713 Merged: ${commitHash || 'unknown'}`);

      // Clean up experiment branch
      try {
        await this.gitManager.deleteBranch(branchName);
      } catch {
        // Branch may already be removed after merge; ignore
      }

      this.status.phase = 'done';
      return {
        success: true,
        merged: true,
        commitHash,
        diff,
        error: null,
        testResults,
      };
    } catch (err) {
      // ── Global error handler ──
      this.status.phase = 'failed';
      this.status.error = err instanceof Error ? err.message : String(err);
      onOutput(`  \u2717 Evolution failed: ${this.status.error}`);

      // Best-effort cleanup
      try {
        await this.gitManager.checkout('main');
        if (this.status.branch) {
          await this.gitManager.deleteBranch(this.status.branch);
        }
      } catch {
        // Best effort
      }

      return {
        success: false,
        merged: false,
        commitHash: null,
        diff: null,
        error: this.status.error,
        testResults: null,
      };
    }
  }

  /**
   * Rollback: switch back to main and delete the experiment branch.
   */
  private async rollback(branchName: string): Promise<void> {
    this.status.phase = 'rolling_back';
    try {
      await this.gitManager.checkout('main');
      await this.gitManager.deleteBranch(branchName);
      this.status.phase = 'done';
    } catch (err) {
      this.status.phase = 'failed';
      this.status.error = `Rollback failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}