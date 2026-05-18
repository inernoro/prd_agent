#!/usr/bin/env bash
# ============================================
# CDS Agent workbench visual smoke
# ============================================
#
# Authenticated V1 check for /cds-agent. This script does not call the
# model provider. It opens the real workbench in headless Chrome, injects
# an admin JWT into the persisted auth store, waits for the runtime debug
# panel, and captures a screenshot as visual evidence.
#
# Required auth, choose one:
#   SMOKE_CDS_AGENT_ACCESS_TOKEN=<jwt>
#   SMOKE_CDS_AGENT_LOGIN_USERNAME=<username> SMOKE_CDS_AGENT_LOGIN_PASSWORD=<password>
#   AI_ACCESS_KEY=<key> [SMOKE_USER=admin]  # smoke-only browser API header injection
#
# Optional:
#   SMOKE_TEST_HOST=http://localhost:5000
#   SMOKE_CDS_AGENT_WORKBENCH_URL=https://.../cds-agent
#   SMOKE_CDS_AGENT_SCREENSHOT=/tmp/cds-agent-workbench-visual.png
#   SMOKE_CDS_AGENT_TEXT_DUMP=/tmp/cds-agent-workbench-visual.txt
#   SMOKE_CDS_AGENT_VISUAL_COVERAGE=/tmp/cds-agent-workbench-visual.coverage.json
#   CHROME_BIN=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=5
SMOKE_CDS_AGENT_WORKBENCH_URL_INPUT="${SMOKE_CDS_AGENT_WORKBENCH_URL:-}"
SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_CDS_AGENT_WORKBENCH_URL_INPUT:-${SMOKE_HOST%/}/cds-agent}"
SMOKE_CDS_AGENT_SCREENSHOT="${SMOKE_CDS_AGENT_SCREENSHOT:-/tmp/cds-agent-workbench-visual.png}"
SMOKE_CDS_AGENT_TEXT_DUMP="${SMOKE_CDS_AGENT_TEXT_DUMP:-/tmp/cds-agent-workbench-visual.txt}"
SMOKE_CDS_AGENT_VISUAL_COVERAGE="${SMOKE_CDS_AGENT_VISUAL_COVERAGE:-/tmp/cds-agent-workbench-visual.coverage.json}"
SMOKE_CDS_AGENT_ACCESS_TOKEN="${SMOKE_CDS_AGENT_ACCESS_TOKEN:-}"
SMOKE_CDS_AGENT_LOGIN_USERNAME="${SMOKE_CDS_AGENT_LOGIN_USERNAME:-}"
SMOKE_CDS_AGENT_LOGIN_PASSWORD="${SMOKE_CDS_AGENT_LOGIN_PASSWORD:-}"
SMOKE_CDS_AGENT_AUTH_MODE="jwt"
CHROME_BIN="${CHROME_BIN:-}"

find_chrome() {
  if [[ -n "$CHROME_BIN" && -x "$CHROME_BIN" ]]; then
    printf '%s\n' "$CHROME_BIN"
    return
  fi
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    printf '%s\n' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return
  fi
  if command -v google-chrome >/dev/null 2>&1; then
    command -v google-chrome
    return
  fi
  if command -v chromium >/dev/null 2>&1; then
    command -v chromium
    return
  fi
  smoke_fail "找不到 Chrome/Chromium；请设置 CHROME_BIN"
}

smoke_init "CDS Agent Workbench Visual"
SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_CDS_AGENT_WORKBENCH_URL_INPUT:-${SMOKE_HOST%/}/cds-agent}"

smoke_step "准备认证 token"
auth_user_json='{"userId":"smoke","username":"smoke","displayName":"Smoke User","role":"ADMIN"}'
if [[ -z "$SMOKE_CDS_AGENT_ACCESS_TOKEN" ]]; then
  if [[ -n "$SMOKE_CDS_AGENT_LOGIN_USERNAME" || -n "$SMOKE_CDS_AGENT_LOGIN_PASSWORD" ]]; then
    if [[ -z "$SMOKE_CDS_AGENT_LOGIN_USERNAME" || -z "$SMOKE_CDS_AGENT_LOGIN_PASSWORD" ]]; then
      smoke_fail "SMOKE_CDS_AGENT_LOGIN_USERNAME/SMOKE_CDS_AGENT_LOGIN_PASSWORD 必须同时设置"
    fi
    SMOKE_CDS_AGENT_AUTH_MODE="login"
  elif [[ -n "${AI_ACCESS_KEY:-}" ]]; then
    SMOKE_CDS_AGENT_AUTH_MODE="ai-access-key"
    SMOKE_CDS_AGENT_ACCESS_TOKEN="ai-access-key-smoke-token"
    auth_user_json=$(jq -cn --arg username "$SMOKE_USER" '{userId:$username,username:$username,displayName:$username,role:"ADMIN"}')
  else
    smoke_fail "需要 SMOKE_CDS_AGENT_ACCESS_TOKEN、登录用户名/密码，或 AI_ACCESS_KEY + SMOKE_USER"
  fi
fi

if [[ "$SMOKE_CDS_AGENT_AUTH_MODE" == "login" ]]; then
  login_body=$(jq -n \
    --arg username "$SMOKE_CDS_AGENT_LOGIN_USERNAME" \
    --arg password "$SMOKE_CDS_AGENT_LOGIN_PASSWORD" \
    '{username:$username,password:$password,clientType:"admin"}')
  login_raw=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent \
    --write-out $'\n%{http_code}' \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$login_body" \
    "$SMOKE_HOST/api/v1/auth/login" || true)
  login_code=$(printf '%s' "$login_raw" | tail -n 1)
  login_resp=$(printf '%s' "$login_raw" | sed '$d')
  if [[ "$login_code" != "200" ]]; then
    smoke_fail "登录失败: HTTP ${login_code}；请检查 SMOKE_CDS_AGENT_LOGIN_USERNAME/SMOKE_CDS_AGENT_LOGIN_PASSWORD 或改用 SMOKE_CDS_AGENT_ACCESS_TOKEN"
  fi
  smoke_assert_eq "$(printf '%s' "$login_resp" | jq -r '.success')" "true" "Login.success"
  SMOKE_CDS_AGENT_ACCESS_TOKEN=$(printf '%s' "$login_resp" | jq -r '.data.accessToken')
  auth_user_json=$(printf '%s' "$login_resp" | jq -c '.data.user')
elif [[ "$SMOKE_CDS_AGENT_AUTH_MODE" == "jwt" ]]; then
  if [[ -n "${SMOKE_CDS_AGENT_AUTH_USER_JSON:-}" ]]; then
    auth_user_json="$SMOKE_CDS_AGENT_AUTH_USER_JSON"
  fi
fi
smoke_assert_nonempty "$SMOKE_CDS_AGENT_ACCESS_TOKEN" "accessToken"
smoke_ok "认证已准备: $SMOKE_CDS_AGENT_AUTH_MODE"

smoke_step "检查页面 HTTP 可达"
page_code=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent --output /dev/null --write-out '%{http_code}' "$SMOKE_CDS_AGENT_WORKBENCH_URL" || true)
smoke_assert_eq "$page_code" "200" "workbench HTTP status"
smoke_ok "workbench HTTP 200: $SMOKE_CDS_AGENT_WORKBENCH_URL"

smoke_step "启动 headless Chrome 并打开工作台"
chrome_path="$(find_chrome)"
tmp_dir="$(mktemp -d /tmp/cds-agent-visual.XXXXXX)"
trap 'rm -rf "$tmp_dir" 2>/dev/null || true' EXIT
node_script="$tmp_dir/visual-smoke.mjs"
cat > "$node_script" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const chromePath = process.env.CHROME_BIN_RESOLVED;
const url = process.env.SMOKE_CDS_AGENT_WORKBENCH_URL;
const token = process.env.SMOKE_CDS_AGENT_ACCESS_TOKEN;
const user = JSON.parse(process.env.SMOKE_CDS_AGENT_AUTH_USER_JSON || '{}');
const aiAccessKey = process.env.AI_ACCESS_KEY || '';
const aiImpersonate = process.env.SMOKE_USER || 'admin';
const authMode = process.env.SMOKE_CDS_AGENT_AUTH_MODE || 'jwt';
const screenshot = process.env.SMOKE_CDS_AGENT_SCREENSHOT;
const textDump = process.env.SMOKE_CDS_AGENT_TEXT_DUMP;
const visualCoverage = process.env.SMOKE_CDS_AGENT_VISUAL_COVERAGE;
const userDataDir = process.env.SMOKE_CDS_AGENT_CHROME_PROFILE;
const port = Number(process.env.SMOKE_CDS_AGENT_CDP_PORT || '9223');
const origin = new URL(url).origin;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function waitForVersion() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { return await httpJson('/json/version'); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

class CdpSocket {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.socket = net.createConnection(Number(this.wsUrl.port), this.wsUrl.hostname);
      this.socket.once('error', reject);
      this.socket.once('connect', () => {
        this.socket.write([
          `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
          `Host: ${this.wsUrl.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          ''
        ].join('\r\n'));
      });
      let handshake = Buffer.alloc(0);
      const onHandshake = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = handshake.subarray(0, idx).toString('utf8');
        if (!head.includes(' 101 ')) {
          reject(new Error(`WebSocket handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        this.socket.off('data', onHandshake);
        this.socket.on('data', (data) => this.onData(data));
        const rest = handshake.subarray(idx + 4);
        if (rest.length) this.onData(rest);
        resolve();
      };
      this.socket.on('data', onHandshake);
    });
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        len = high * 2 ** 32 + low;
        offset += 8;
      }
      const masked = Boolean(second & 0x80);
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (masked && mask) {
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      }
      const opcode = first & 0x0f;
      if (opcode === 8) return;
      if (opcode !== 1) continue;
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.recordEvent(msg);
      }
    }
  }

  recordEvent(msg) {
    if (![
      'Runtime.exceptionThrown',
      'Runtime.consoleAPICalled',
      'Log.entryAdded',
      'Network.loadingFailed'
    ].includes(msg.method)) return;
    this.events.push(msg);
    if (this.events.length > 40) this.events.shift();
  }

  eventSummary() {
    return this.events.map((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params?.exceptionDetails || {};
        return `exception: ${details.text || ''} ${details.exception?.description || details.exception?.value || ''}`.trim();
      }
      if (event.method === 'Runtime.consoleAPICalled') {
        const args = (event.params?.args || []).map((arg) => arg.value || arg.description || arg.type).join(' ');
        return `console.${event.params?.type || 'log'}: ${args}`.trim();
      }
      if (event.method === 'Log.entryAdded') {
        const entry = event.params?.entry || {};
        return `log.${entry.level || 'info'}: ${entry.text || ''}`.trim();
      }
      if (event.method === 'Network.loadingFailed') {
        return `network.failed: ${event.params?.errorText || ''} ${event.params?.blockedReason || ''}`.trim();
      }
      return event.method;
    }).filter(Boolean).slice(-12);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | payload.length;
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }

  close() {
    try { this.socket.end(); } catch {}
  }
}

async function main() {
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (chunk) => { chromeErr += chunk.toString(); });
  try {
    const version = await waitForVersion();
    const cdp = new CdpSocket(version.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const target = await cdp.send('Target.createTarget', { url: `${origin}/login` });
    const attach = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attach.sessionId;
    const send = (method, params = {}) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    if (authMode === 'ai-access-key') {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const aiAccessKey = ${JSON.stringify(aiAccessKey)};
            const aiImpersonate = ${JSON.stringify(aiImpersonate)};
            const shouldPatch = (value) => {
              try {
                const target = new URL(value, window.location.origin);
                return target.origin === window.location.origin && target.pathname.startsWith('/api/');
              } catch {
                return false;
              }
            };
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init = {}) => {
              const rawUrl = typeof input === 'string' ? input : input && input.url;
              if (!shouldPatch(rawUrl || '')) return originalFetch(input, init);
              const sourceHeaders = init.headers || (input instanceof Request ? input.headers : undefined);
              const headers = new Headers(sourceHeaders || {});
              headers.set('X-AI-Access-Key', aiAccessKey);
              headers.set('X-AI-Impersonate', aiImpersonate);
              headers.delete('Authorization');
              if (input instanceof Request) {
                return originalFetch(new Request(input, { headers }), init);
              }
              return originalFetch(input, { ...init, headers });
            };
          })();
        `
      });
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    });
    await send('Page.navigate', { url: `${origin}/login` });
    await waitForReady(send);
    const persisted = {
      state: {
        isAuthenticated: true,
        user,
        token,
        refreshToken: null,
        sessionKey: null,
        permissions: [],
        permissionsLoaded: false,
        isRoot: user?.userId === 'root' || user?.username === 'root',
        menuCatalog: [],
        menuCatalogLoaded: false,
        cdnBaseUrl: '',
        permFingerprint: ''
      },
      version: 0
    };
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('prd-admin-auth', ${JSON.stringify(JSON.stringify(persisted))})`,
      awaitPromise: true
    });
    await send('Runtime.evaluate', {
      expression: `sessionStorage.setItem('cds-agent:view-mode', 'pro')`,
      awaitPromise: true
    });
    await send('Page.navigate', { url });
    await waitForWorkbench(send, cdp);
    const textResult = await send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true
    });
    const text = textResult.result?.value || '';
    const required = [
      'CDS Agent',
      '当前执行面板',
      'Runtime 调试',
      '当前执行结论',
      '重新部署',
      '部署判定',
      '命令性质',
      'Provider 调用',
      '不需要重新部署',
      'R1 dry-run',
      '不会触发真实 provider 调用',
      '商业级',
      'READINESS LEDGER',
      '下一周期最小闭环',
      'official-sdk-provider-closure',
      'profile-blocked',
      'N1',
      'N6',
      '停止条件',
      'ADAPTER 兼容性',
      'Legacy loop import',
      'lazy-explicit-fallback',
      '默认路由',
      '缺失 adapter contract',
      '候选 adapter 边界'
    ];
    const missing = required.filter((item) => !text.includes(item));
    if (textDump) {
      fs.writeFileSync(textDump, text);
    }
    if (visualCoverage) {
      fs.writeFileSync(visualCoverage, JSON.stringify({
        schemaVersion: 'cds-agent-workbench-visual-coverage/v1',
        checkedAt: new Date().toISOString(),
        url,
        required,
        missing,
        assertionsPassed: missing.length === 0
      }, null, 2));
    }
    if (missing.length) {
      throw new Error(`Workbench missing expected text: ${missing.join(', ')}`);
    }
    await send('Runtime.evaluate', {
      expression: `(() => {
        const nodes = Array.from(document.querySelectorAll('section, div, article'))
          .filter((node) => (node.innerText || '').includes('当前执行面板'))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        const el = nodes[0];
        if (el) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        }
        return false;
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    await new Promise((r) => setTimeout(r, 500));
    const screenshotResult = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshot, Buffer.from(screenshotResult.data, 'base64'));
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    cdp.close();
  } finally {
    chrome.kill('SIGTERM');
    if (process.env.SMOKE_VERBOSE && chromeErr.trim()) {
      console.error(chromeErr.trim());
    }
  }
}

async function waitForReady(send) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const res = await send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true
    }).catch(() => null);
    if (res?.result?.value === 'complete') return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Page did not reach readyState=complete');
}

async function waitForWorkbench(send, cdp) {
  const deadline = Date.now() + 45000;
  let lastText = '';
  while (Date.now() < deadline) {
    const res = await send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true
    }).catch(() => null);
    const text = res?.result?.value || '';
    lastText = text;
    try { fs.writeFileSync(textDump, text); } catch {}
    if (text.includes('当前执行面板')
      && text.includes('Runtime 调试')
      && text.includes('商业级')
      && text.includes('当前执行结论')
      && text.includes('重新部署')
      && text.includes('部署判定')
      && text.includes('命令性质')
      && text.includes('Provider 调用')
      && text.includes('不需要重新部署')
      && text.includes('R1 dry-run')
      && text.includes('不会触发真实 provider 调用')
      && text.includes('READINESS LEDGER')
      && text.includes('下一周期最小闭环')
      && text.includes('official-sdk-provider-closure')
      && text.includes('profile-blocked')
      && text.includes('N1')
      && text.includes('N6')
      && text.includes('停止条件')
      && text.includes('ADAPTER 兼容性')
      && text.includes('Legacy loop import')
      && text.includes('lazy-explicit-fallback')
      && text.includes('默认路由')
      && text.includes('缺失 adapter contract')
      && text.includes('候选 adapter 边界')) return;
    if (text.includes('无权限访问')) throw new Error('Authenticated user lacks permission for /cds-agent');
    if (text.includes('登录') && text.includes('密码') && !text.includes('CDS Agent')) {
      throw new Error('Auth store injection failed; still on login page');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshot.replace(/\.png$/i, '.failure.png'), Buffer.from(shot.data, 'base64'));
  } catch {}
  const eventSummary = cdp.eventSummary();
  const suffix = eventSummary.length ? `; events=${eventSummary.join(' | ')}` : '';
  throw new Error(`Workbench runtime debug panel did not render before timeout; lastText=${lastText.slice(0, 500).replace(/\s+/g, ' ')}${suffix}`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
NODE

CHROME_BIN_RESOLVED="$chrome_path" \
SMOKE_CDS_AGENT_WORKBENCH_URL="$SMOKE_CDS_AGENT_WORKBENCH_URL" \
SMOKE_CDS_AGENT_SCREENSHOT="$SMOKE_CDS_AGENT_SCREENSHOT" \
SMOKE_CDS_AGENT_TEXT_DUMP="$SMOKE_CDS_AGENT_TEXT_DUMP" \
SMOKE_CDS_AGENT_VISUAL_COVERAGE="$SMOKE_CDS_AGENT_VISUAL_COVERAGE" \
SMOKE_CDS_AGENT_ACCESS_TOKEN="$SMOKE_CDS_AGENT_ACCESS_TOKEN" \
SMOKE_CDS_AGENT_AUTH_USER_JSON="$auth_user_json" \
SMOKE_CDS_AGENT_AUTH_MODE="$SMOKE_CDS_AGENT_AUTH_MODE" \
AI_ACCESS_KEY="${AI_ACCESS_KEY:-}" \
SMOKE_USER="$SMOKE_USER" \
SMOKE_CDS_AGENT_CHROME_PROFILE="$tmp_dir/profile" \
SMOKE_CDS_AGENT_CDP_PORT="${SMOKE_CDS_AGENT_CDP_PORT:-$(( 9223 + RANDOM % 1000 ))}" \
node "$node_script"
smoke_ok "页面文本断言通过"

smoke_step "保存截图证据"
if [[ ! -s "$SMOKE_CDS_AGENT_SCREENSHOT" ]]; then
  smoke_fail "截图未生成: $SMOKE_CDS_AGENT_SCREENSHOT"
fi
printf 'Screenshot: %s\n' "$SMOKE_CDS_AGENT_SCREENSHOT"
printf 'Text dump: %s\n' "$SMOKE_CDS_AGENT_TEXT_DUMP"
printf 'Visual coverage: %s\n' "$SMOKE_CDS_AGENT_VISUAL_COVERAGE"
smoke_ok "截图已保存"

smoke_step "完成 V1 视觉验收"
smoke_done
