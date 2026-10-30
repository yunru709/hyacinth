import http from 'node:http';
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { console.log(`${port}: HTTP ${res.statusCode} ${d.slice(0, 180)}`); resolve(); });
    });
    req.on('error', (e) => { console.log(`${port}: ERR ${e.message}`); resolve(); });
    req.setTimeout(3000, () => { req.destroy(); console.log(`${port}: timeout`); resolve(); });
  });
}
await probe(3130);
await probe(3199);
