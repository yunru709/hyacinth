const { detectImagePaths, IMAGE_MIME_MAP } = require('../dist/multimodal/index.js');

const testInputs = [
  '看看 C:\\Users\\testuser\\Desktop\\photo.png 里有什么',
  'C:/Users/testuser/Pictures/cat.jpg analyze this',
  'D:\\images\\dog.webp 识别一下',
  '普通文本没有图片路径',
];

for (const input of testInputs) {
  const paths = detectImagePaths(input);
  console.log('Input:', JSON.stringify(input.slice(0, 80)));
  console.log('Detected:', paths.length > 0 ? paths : 'NONE');
  console.log();
}

// Also test the regex directly
const pathRegex = /(?:["'`])?([A-Za-z]:[^\s"']*\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tiff?))(?:["'`])?/gi;
for (const input of testInputs) {
  const matches = [...input.matchAll(pathRegex)];
  console.log('Regex matches for:', JSON.stringify(input.slice(0, 60)), '→', matches.length, 'matches');
  for (const m of matches) {
    console.log('  match[1]:', m[1]);
  }
}
