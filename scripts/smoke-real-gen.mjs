// 真实 API 冒烟：走 GenerateImageTool 完整链路
import { GenerateImageTool } from '../dist/tools/generate-image.js';

const tool = new GenerateImageTool(process.cwd());
const result = await tool.execute({
  prompt: '星际穿越，黑洞，黑洞里冲出一辆快支离破碎的复古列车，电影大片，末日既视感，动感，对比色，oc渲染，光线追踪，超现实主义，深蓝，暗黑风背景的光影效果，广角透视，耀光，反射，极致的光影，强引力',
  negative_prompt: '模糊，低画质，变形',
  size: '2K',
});
console.log('=== RESULT ===');
console.log(result);
