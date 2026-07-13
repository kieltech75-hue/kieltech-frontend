const http = require('http');
const { init } = require('./db');
const { handleRoutes } = require('./routes');

const PORT = process.env.PORT || 5000;

async function start() {
  await init();

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    handleRoutes(req, res).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Server error' }));
    });
  });

  server.listen(PORT, () => {
    console.log(`KielTech backend listening on port ${PORT}`);
  });
}

start();
