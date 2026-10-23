// CPU spinner: keep one thread busy for N ms. Usage: node spin.mjs [ms]
const ms = Number(process.argv[2] || 8000);
const end = Date.now() + ms;
let x = 1.0000001;
let iters = 0;
while (Date.now() < end) {
  for (let i = 0; i < 50000; i++) {
    x = Math.sqrt(x + 1.0000001) * 1.0000001;
  }
  iters += 50000;
}
console.log(JSON.stringify({ x: Number(x.toFixed(6)), iters }));
