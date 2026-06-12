/**
 * Build a system prompt for Agent to modify its own code.
 * The prompt instructs the model about what it can/cannot change.
 */
export function buildEvolutionPrompt(targetFiles: string[]): string {
  const filesList = targetFiles.map(f => `  - ${f}`).join('\n');

  return `# Self-Evolution Mode

You are modifying your own source code to improve the Agent framework.
You have access to read and edit these target files:

${filesList}

## Rules (MUST follow):
1. ONLY modify the files listed above. Do not touch any other files.
2. Keep backward compatibility — all existing exported functions/types must remain.
3. Do NOT add new npm dependencies. Use only existing packages.
4. After each set of changes, run: git add -A && git commit -m "evolve: <describe change>"
5. The code must pass: tsc --noEmit (TypeScript compilation check).
6. All existing tests must still pass.
7. Do NOT change any test files.
8. Changes should be incremental and focused — one improvement per evolution cycle.

## What to improve:
- Performance: reduce allocations, cache repeated computations, optimize hot paths
- Readability: simplify complex logic, improve naming, add clarifying comments
- Correctness: fix subtle bugs, edge cases, error handling gaps
- Architecture: reduce coupling, improve separation of concerns

## Commit message format:
evolve: <component>: <brief description of change>

Example:
evolve: compressor: optimize token counting to use sliding window`;
}

/**
 * Generate standard test messages for the new Agent instance.
 * Old Agent will send these to the new instance and verify responses.
 */
export function buildTestMessages(): string[] {
  return [
    'Hello, are you operational? Respond with "OK"',
    'What is the current working directory?',
    'Run a simple calculation: what is 2 + 3?',
    'List the files in the current directory',
    'What is your current mode setting?',
  ];
}

/**
 * Evaluate test response from new Agent instance.
 * Returns true if the response looks valid.
 */
export function evaluateTestResponse(question: string, response: string): boolean {
  if (!response || response.trim().length === 0) return false;
  // Simple heuristics: response should not be empty, should not contain crash/error indicators
  const crashKeywords = ['Error:', 'TypeError', 'ReferenceError', 'SyntaxError', 'Cannot find module', 'Segmentation fault'];
  const lowerResponse = response.toLowerCase();
  for (const kw of crashKeywords) {
    if (lowerResponse.includes(kw.toLowerCase())) return false;
  }
  // Specific checks
  if (question.includes('OK')) {
    return lowerResponse.includes('ok');
  }
  if (question.includes('2 + 3')) {
    return response.includes('5');
  }
  return true;
}