// A stand-in for `node apps/daemon/dist/cli.js`: a real child process that listens on OD_PORT,
// answers /api/health like OpenDesign 0.21.1, and records the environment it was started with.
// Used to exercise the real OpenDesignDaemon process supervision (spawn, stop, unexpected exit).
import fs from 'node:fs';
import http from 'node:http';

const envDump = process.argv[2];
if (envDump) fs.writeFileSync(envDump, JSON.stringify(process.env));

const token = process.env.OD_API_TOKEN;
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.21.1' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.OD_PORT), process.env.OD_BIND_HOST || '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
