export interface UpdateConfig {
  repo?: string;
  sourcePath?: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  publishedAt: string;
  needsUpdate: boolean;
}

export interface DownloadProgress {
  percent: number;
  downloaded: number;
  total: number;
}
