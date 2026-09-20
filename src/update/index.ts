export { loadConfig, saveConfig } from './config.js';
export { checkForUpdate } from './check.js';
export { downloadWithProgress } from './download.js';
export { findExtractedDir, stageRelease, smokeTestRelease } from './install.js';
export type { StageReleaseOptions, StageReleaseResult } from './install.js';
export {
  resolveInstallRoot,
  readPointer,
  writePointerAtomic,
  listReleases,
  pruneReleases,
  migrateLegacyDist,
  releaseDir,
} from './releases.js';
export type { ReleasePointer } from './releases.js';
export type { UpdateConfig, VersionInfo, DownloadProgress } from './types.js';
