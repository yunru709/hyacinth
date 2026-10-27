/* v2 视图出口：把 misc.js 里的五个视图重新导出为独立模块，
   让 main.js 的 import 路径保持「一个视图一个文件」的语义。 */
export { sessionsView } from './misc.js';
export { skillsView } from './misc.js';
export { pluginsView } from './misc.js';
export { scheduleView } from './misc.js';
export { settingsView } from './misc.js';
