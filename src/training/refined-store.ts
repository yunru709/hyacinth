import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface RefinedSample {
  instruction: string;
  input: string;
  output: string;
  metadata?: {
    source?: string;
    createdAt?: string;
    [key: string]: unknown;
  };
}

export class RefinedDataStore {
  private baseDir: string;

  constructor(projectRoot: string) {
    this.baseDir = join(projectRoot, "training_data", "refined");
  }

  async save(version: number, samples: RefinedSample[]): Promise<void> {
    const versionDir = join(this.baseDir, `v${version}`);
    if (!existsSync(versionDir)) {
      await mkdir(versionDir, { recursive: true });
    }

    const jsonlLines = samples.map((sample) =>
      JSON.stringify({
        instruction: sample.instruction,
        input: sample.input,
        output: sample.output,
      })
    );
    const jsonlContent = jsonlLines.join("\n");
    await writeFile(join(versionDir, "chatml.jsonl"), jsonlContent, "utf-8");

    const hasSource = samples.some((s) => s.metadata?.source !== undefined);
    const meta = {
      version,
      sampleCount: samples.length,
      createdAt: new Date().toISOString(),
      sourceSummary: hasSource,
    };
    await writeFile(join(versionDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  }

  async load(version: number): Promise<RefinedSample[]> {
    const filePath = join(this.baseDir, `v${version}`, "chatml.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      const parsed = JSON.parse(line) as {
        instruction: string;
        input: string;
        output: string;
      };
      return {
        instruction: parsed.instruction,
        input: parsed.input,
        output: parsed.output,
      };
    });
  }

  async listVersions(): Promise<number[]> {
    if (!existsSync(this.baseDir)) {
      return [];
    }
    const entries = await readdir(this.baseDir);
    const versions: number[] = [];
    for (const entry of entries) {
      const match = entry.match(/^v(\d+)$/);
      if (match) {
        versions.push(parseInt(match[1], 10));
      }
    }
    return versions.sort((a, b) => a - b);
  }
}
