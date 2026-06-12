import type { VersionInfo } from './types.js';

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

interface CheckResult {
  version: VersionInfo;
  downloadUrl: string;
}

export async function checkForUpdate(
  repo: string,
  currentVersion: string,
  onStatus: (msg: string) => void,
): Promise<CheckResult | null> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  onStatus(`查询最新版: ${apiUrl}`);

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json() as GitHubRelease;

    const latest = release.tag_name.replace(/^v/, '');
    const zip = release.assets?.find(a => a.name.endsWith('.zip'));
    if (!zip) throw new Error('No .zip asset found');

    const needsUpdate = latest !== currentVersion;
    return {
      version: {
        current: currentVersion,
        latest,
        publishedAt: release.published_at,
        needsUpdate,
      },
      downloadUrl: zip.browser_download_url,
    };
  } catch (err) {
    throw new Error(`版本检查失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
