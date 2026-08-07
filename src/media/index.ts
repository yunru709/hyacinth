/**
 * 媒体库（MediaStore）— 独立于知识库的媒体索引 + 文件管理
 *
 * 存储位置：
 *  - 数据库：~/.agent/media/media.sqlite
 *  - 文件：  ~/.agent/media/files/
 *
 * 用途：scene_render 产物、generate_image/video 产物回填，WebUI 经 serve 查询。
 * 独立库设计：与知识库（kb.sqlite）完全隔离，删知识库不影响媒体数据。
 */

export { MediaStore } from './media-store.js';
export {
  getMediaDir,
  getMediaDbPath,
  getMediaFilesDir,
  inferMediaType,
  recordMediaFile,
} from './media-store.js';
export type {
  MediaType,
  MediaSource,
  MediaEntry,
  MediaRecord,
  MediaFilter,
} from './media-store.js';
