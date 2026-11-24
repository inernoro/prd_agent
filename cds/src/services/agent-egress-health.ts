// Start one lightweight process: repeated docker exec + fetch startup can consume
// the entire readiness window on the relay's deliberately small CPU quota.
export const EGRESS_HEALTH_EXEC_TIMEOUT_MS = 45_000;
export const EGRESS_PROXY_PORT = 8787;
export const EGRESS_HEALTH_PROBE_SCRIPT = String.raw`
const http = require('node:http');
const deadline = Date.now() + 30000;
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  process.exit(code);
};
const overall = setTimeout(() => finish(1), 30000);
const probe = () => {
  if (finished) return;
  if (Date.now() >= deadline) return finish(1);
  let settled = false;
  const retry = () => {
    if (settled || finished) return;
    settled = true;
    setTimeout(probe, Math.min(250, Math.max(0, deadline - Date.now())));
  };
  const request = http.get('http://127.0.0.1:${EGRESS_PROXY_PORT}/__health', (response) => {
    response.resume();
    if (response.statusCode === 204) {
      settled = true;
      clearTimeout(overall);
      finish(0);
    } else {
      request.destroy();
      retry();
    }
  });
  request.setTimeout(Math.min(2000, Math.max(1, deadline - Date.now())), () => {
    request.destroy();
    retry();
  });
  request.on('error', retry);
};
probe();
`;
