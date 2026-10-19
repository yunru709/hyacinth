export { loadConfig, saveConfig } from './config.js';
export { checkForUpdate } from './check.js';
export { downloadWithProgress } from './download.js';
export { findExtractedDir, stageRelease, smokeTestRelease, ensureSelfBuildBaseline, commitRelease } from './install.js';
export type { StageReleaseOptions, StageReleaseResult, CommitReleaseOptions } from './install.js';
export {
  resolveInstallRoot,
  readPointer,
  writePointerAtomic,
  listReleases,
  pruneReleases,
  migrateLegacyDist,
  releaseDir,
  releaseExists,
  makeBuildId,
  writeReleaseMeta,
  readReleaseMeta,
  writeRollbackRecord,
  readRollbackRecord,
} from './releases.js';
export type { ReleasePointer, ReleaseMeta, RollbackRecord } from './releases.js';
export type { UpdateConfig, VersionInfo, DownloadProgress } from './types.js';
