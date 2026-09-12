/**
 * EasyEDA WebSocket Bridge Server
 *
 * 这是一个 Node.js WebSocket 服务端，用于桥接 AI 编程工具和 EasyEDA Pro 客户端。
 * 支持所有兼容 Agent Skills 标准的工具（Claude Code、OpenCode、QwenCode 等）。
 *
 * 架构：
 *   ┌──────────────┐   HTTP/WS     ┌────────────────┐   WebSocket    ┌──────────┐
 *   │   AI Agent    │ ◄───────────► │  Bridge Server  │ ◄───────────► │  EasyEDA  │
 *   │  (Skill Tool) │  Port Range   │  (This Server)  │  Port Range   │  (Client) │
 *   └──────────────┘  49620-49629   └────────────────┘  49620-49629   └──────────┘
 *
 * 端口范围 49620-49629，启动时自动检测可用端口。
 * EasyEDA 扩展通过 eda.sys_WebSocket.register() 连接到此服务。
 * AI 通过 HTTP API 或直接 WebSocket 发送代码执行请求。
 *
 * 握手验证协议：
 * - GET /health 返回 { service: "easyeda-bridge", ... }
 * - WebSocket 连接后服务端发送 { type: "handshake", service: "easyeda-bridge" }
 * - 客户端需验证 service 字段匹配后才确认连接有效
 *
 * 协议格式（JSON）：
 * {
 *   "type": "execute" | "result" | "error" | "ping" | "pong" | "handshake",
 *   "id": "<request-uuid>",
 *   "code": "<js code string>",           // execute 时
 *   "result": <any>,                       // result 时
 *   "error": "<error message>",            // error 时
 *   "timestamp": <unix ms>
 * }
 *
 * ─── Security model / 安全模型 ───────────────────────────────────────
 *
 * This server executes arbitrary JavaScript inside the user's EasyEDA client.
 * Anything that can reach it owns the user's designs. Four controls gate access:
 *
 *   1. Loopback bind (127.0.0.1) — not reachable from the network.
 *   2. Host header allowlist — defeats DNS rebinding, where a hostile page uses
 *      a domain that resolves to 127.0.0.1 and therefore sends no useful Origin.
 *   3. Origin rejection — any request carrying a browser Origin is refused on the
 *      agent-facing surfaces (HTTP API and the /agent WebSocket). CLI agents send
 *      no Origin; web pages always do. This closes the localhost drive-by where a
 *      site you happen to be visiting scans the port range and posts code.
 *      The /eda path additionally accepts the official EasyEDA web origins, since
 *      the browser-hosted EDA client legitimately connects from one.
 *   4. Bearer token — a per-run secret required on every agent-facing surface,
 *      written to ~/.easyeda-bridge/token (0600). The EDA extension is exempt:
 *      it has no way to learn the token, so /eda is gated by 1-3 plus a
 *      registration lock that stops a second client from stealing a window ID.
 *
 * Residual risk: any process running as this user can read the token file. This
 * is a same-user boundary, not a sandbox.
 */

import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { createConnection } from 'node:net';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Port Configuration ─────────────────────────────────────────────
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const LISTEN_HOST = '127.0.0.1';

// ─── Security Configuration ─────────────────────────────────────────
/** Max accepted request body. Prevents an unbounded local memory DoS. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Where the port/token handshake material is published for the local agent. */
const STATE_DIR = join(homedir(), '.easyeda-bridge');
const SESSION_FILE = join(STATE_DIR, 'session.json');
const TOKEN_FILE = join(STATE_DIR, 'token');

/**
 * Per-run bearer token. Set EASYEDA_BRIDGE_TOKEN to pin a stable value
 * (useful when the agent is started before the bridge); otherwise a fresh
 * 256-bit secret is minted on every start.
 */
const AUTH_TOKEN = (process.env.EASYEDA_BRIDGE_TOKEN || '').trim() || randomBytes(32).toString('hex');

/** Host header values that mean "someone typed a loopback address". */
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Browser origins allowed to open the EDA-facing WebSocket. The desktop client
 * sends no Origin at all; the web client sends one of these. Extend via
 * EASYEDA_BRIDGE_ALLOWED_ORIGINS (comma separated).
 */
const EDA_ALLOWED_ORIGINS = new Set([
  'https://pro.easyeda.com',
  'https://easyeda.com',
  'https://pro.lceda.cn',
  'https://lceda.cn',
  ...(process.env.EASYEDA_BRIDGE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
]);

function formatBannerLine(label, value) {
  return `║  ${`${label}:`.padEnd(12)} ${String(value).padEnd(44)}║`;
}

// ─── State ──────────────────────────────────────────────────────────
/** @type {Map<string, import('ws').WebSocket>} EDA window ID -> WebSocket */
const edaClients = new Map();

/** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, windowId: string}>} */
const pendingRequests = new Map();

/** @type {string | null} 当前AI端选中的EDA窗口ID */
let activeEdaWindowId = null;

const REQUEST_TIMEOUT_MS = 30_000;

// ─── Security Helpers ───────────────────────────────────────────────

/**
 * Verify the Host header names a loopback address.
 * A DNS-rebinding page reaches 127.0.0.1 but carries its own hostname here.
 * @param {string | undefined} hostHeader
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const raw = String(hostHeader).trim().toLowerCase();
  let name = raw;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    name = close === -1 ? raw : raw.slice(0, close + 1);
  } else {
    const firstColon = raw.indexOf(':');
    if (firstColon !== -1 && firstColon === raw.lastIndexOf(':')) {
      name = raw.slice(0, firstColon);
    }
  }
  return ALLOWED_HOSTNAMES.has(name);
}

/**
 * True when the request came from a web page. Browsers always attach Origin to
 * cross-origin fetches and WebSocket upgrades; CLI clients attach none.
 * "null" is the opaque origin used by sandboxed frames and data: URLs.
 * @param {string | undefined} origin
 * @returns {boolean}
 */
function isBrowserOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).trim().toLowerCase();
  return o === 'null' || o.startsWith('http://') || o.startsWith('https://');
}

/**
 * @param {string | undefined} origin
 * @returns {boolean} true if this browser origin may drive the EDA path
 */
function isAllowedEdaOrigin(origin) {
  if (!origin) return true;
  return EDA_ALLOWED_ORIGINS.has(String(origin).trim().toLowerCase());
}

/**
 * Constant-time token comparison.
 * @param {string | null | undefined} provided
 * @returns {boolean}
 */
function isValidToken(provided) {
  if (!provided) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(AUTH_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull the bearer token from Authorization, X-Bridge-Token, or ?token=.
 * The query form exists for WebSocket clients that cannot set headers; it is
 * the weakest of the three because URLs land in logs, so prefer a header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch {
    /* ignore malformed request targets */
  }
  return null;
}

/**
 * Request path with any query string stripped.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function pathOf(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

/**
 * Apply the Host / Origin / token gate to an HTTP request.
 * Writes the rejection itself and returns false when the request is refused.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ requireAuth?: boolean }} [options]
 * @returns {boolean} true if the handler may proceed
 */
function passesHttpGate(req, res, options = {}) {
  const { requireAuth = true } = options;

  const deny = (status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };

  if (!isLoopbackHost(req.headers.host)) {
    console.warn(`[SEC] Rejected request with non-loopback Host: ${req.headers.host}`);
    deny(403, 'Invalid Host header — this service is loopback only');
    return false;
  }
  if (isBrowserOrigin(req.headers.origin)) {
    console.warn(`[SEC] Rejected browser-origin request from ${req.headers.origin} to ${pathOf(req)}`);
    deny(403, 'Requests from web pages are not accepted');
    return false;
  }
  if (requireAuth && !isValidToken(extractToken(req))) {
    console.warn(`[SEC] Rejected unauthenticated request to ${pathOf(req)}`);
    deny(401, `Missing or invalid bridge token — read it from ${TOKEN_FILE}`);
    return false;
  }
  return true;
}

/**
 * Read a request body, refusing anything oversized.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Publish port + token for the local agent, readable only by this user.
 * @param {number} port
 */
function writeSessionFile(port) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const payload = {
    service: SERVICE_ID,
    port,
    token: AUTH_TOKEN,
    pid: process.pid,
    startedAt: Date.now(),
  };
  // Remove first: the mode argument only applies when the file is created.
  rmSync(SESSION_FILE, { force: true });
  rmSync(TOKEN_FILE, { force: true });
  writeFileSync(SESSION_FILE, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(TOKEN_FILE, `${AUTH_TOKEN}\n`, { mode: 0o600 });
}

let sessionFileWritten = false;

function cleanupSessionFile() {
  if (!sessionFileWritten) return;
  sessionFileWritten = false;
  try {
    rmSync(SESSION_FILE, { force: true });
    rmSync(TOKEN_FILE, { force: true });
  } catch {
    /* best effort on shutdown */
  }
}

process.on('exit', cleanupSessionFile);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanupSessionFile();
    process.exit(0);
  });
}

// ─── Port Detection ─────────────────────────────────────────────────

/**
 * Check if a TCP port is already in use.
 * @param {number} port
 * @returns {Promise<boolean>} true if port is in use
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(300);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Check if a port is already running our bridge service.
 * Sends HTTP GET /health and verifies { service: "easyeda-bridge" }.
 *
 * NOTE: this is advisory only. Any local process can answer with our service
 * string, so a squatter can make us stand down and take our place. Set
 * EASYEDA_BRIDGE_NO_SINGLETON=1 to skip the check and always bind our own port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isBridgeRunning(port) {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/health`, { timeout: 800 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.service === SERVICE_ID);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Detect if an existing bridge instance is already running in the port range.
 * @returns {Promise<number|null>} The port of the existing instance, or null
 */
async function findExistingInstance() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (await isBridgeRunning(port)) return port;
  }
  return null;
}

/**
 * Find the first available port in range.
 * @returns {Promise<number>}
 */
async function findAvailablePort() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    const inUse = await isPortInUse(port);
    if (!inUse) return port;
  }
  throw new Error(`All ports in range ${PORT_START}-${PORT_END} are in use`);
}

// ─── HTTP Server (for AI to submit code via HTTP POST) ─────────────
const httpServer = createServer(async (req, res) => {
  // No CORS headers are emitted: browsers must not be able to read our
  // responses, and a preflight that receives no Access-Control-Allow-Origin
  // fails closed.
  if (req.method === 'OPTIONS') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Cross-origin requests are not supported' }));
    return;
  }

  const path = pathOf(req);

  // Health check — includes service identifier for client handshake verification.
  // Unauthenticated so both the agent and the EDA extension can discover the
  // port, but still Host/Origin gated, and it no longer leaks window IDs.
  if (req.method === 'GET' && path === '/health') {
    if (!passesHttpGate(req, res, { requireAuth: false })) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: SERVICE_ID,
      status: 'ok',
      edaConnected: edaClients.size > 0,
      edaWindowCount: edaClients.size,
      authRequired: true,
      timestamp: Date.now(),
    }));
    return;
  }

  // List all connected EDA windows
  if (req.method === 'GET' && path === '/eda-windows') {
    if (!passesHttpGate(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const windows = [];
    for (const [windowId, ws] of edaClients) {
      windows.push({
        windowId,
        connected: ws.readyState === 1,
        active: windowId === activeEdaWindowId,
      });
    }
    res.end(JSON.stringify({
      windows,
      activeWindowId: activeEdaWindowId,
      count: edaClients.size,
    }));
    return;
  }

  // Set active EDA window
  if (req.method === 'POST' && path === '/eda-windows/select') {
    if (!passesHttpGate(req, res)) return;
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid request body: ${err.message}` }));
      return;
    }

    const { windowId } = payload;
    if (!edaClients.has(windowId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `EDA window "${windowId}" not found` }));
      return;
    }
    activeEdaWindowId = windowId;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, activeWindowId: activeEdaWindowId }));
    return;
  }

  // Execute code on EDA
  if (req.method === 'POST' && path === '/execute') {
    if (!passesHttpGate(req, res)) return;
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid request body: ${err.message}` }));
      return;
    }

    const code = payload.code;
    const windowId = payload.windowId; // optional, uses active window if not specified
    if (!code || typeof code !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "code" field (string)' }));
      return;
    }

    try {
      const result = await executeOnEda(code, windowId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result, windowId: windowId || activeEdaWindowId }));
    } catch (err) {
      const status = err.message?.includes('not connected') ? 503 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── WebSocket Server ───────────────────────────────────────────────
// WebSockets are exempt from the same-origin policy, so the HTTP gate above
// buys nothing here — the upgrade must be checked independently.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: ({ req, origin }, done) => {
    const path = pathOf(req);

    if (!isLoopbackHost(req.headers.host)) {
      console.warn(`[SEC] Rejected WS upgrade with non-loopback Host: ${req.headers.host}`);
      done(false, 403, 'Invalid Host header');
      return;
    }

    if (path === '/eda') {
      // The EDA extension cannot carry a token, so this path is gated on origin
      // alone: the desktop client sends none, the web client sends an official one.
      if (!isAllowedEdaOrigin(origin)) {
        console.warn(`[SEC] Rejected EDA WS upgrade from disallowed origin: ${origin}`);
        done(false, 403, 'Origin not allowed for the EDA endpoint');
        return;
      }
      done(true);
      return;
    }

    // Agent path: no browsers, and a valid token.
    if (isBrowserOrigin(origin)) {
      console.warn(`[SEC] Rejected agent WS upgrade from browser origin: ${origin}`);
      done(false, 403, 'Requests from web pages are not accepted');
      return;
    }
    if (!isValidToken(extractToken(req))) {
      console.warn('[SEC] Rejected agent WS upgrade with missing or invalid token');
      done(false, 401, 'Missing or invalid bridge token');
      return;
    }
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  const clientType = pathOf(req) === '/eda' ? 'eda' : 'agent';
  console.log(`[WS] New ${clientType} connection from ${req.socket.remoteAddress}`);

  // Send handshake message for client verification
  ws.send(JSON.stringify({
    type: 'handshake',
    service: SERVICE_ID,
    clientType,
    timestamp: Date.now(),
  }));

  if (clientType === 'eda') {
    let registeredWindowId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register' && msg.windowId) {
          // Window IDs are client-asserted, so a second client claiming a live
          // ID would silently displace the real window and receive the code
          // meant for it. First registration wins until it disconnects.
          const existing = edaClients.get(msg.windowId);
          if (existing && existing !== ws && existing.readyState === 1) {
            console.warn(`[SEC] Refused duplicate registration for live window: ${msg.windowId}`);
            ws.close(4009, 'windowId already registered');
            return;
          }
          // EDA client registering with window ID
          registeredWindowId = msg.windowId;
          edaClients.set(registeredWindowId, ws);
          // Auto-select if first window or if no active window
          if (edaClients.size === 1 || !activeEdaWindowId) {
            activeEdaWindowId = registeredWindowId;
          }
          console.log(`[WS] EDA window registered: ${registeredWindowId}, total: ${edaClients.size}`);
          return;
        }
        // Always pass a valid windowId (use registeredWindowId if available, otherwise log warning)
        const effectiveWindowId = registeredWindowId || 'unregistered';
        handleEdaMessage(msg, effectiveWindowId);
      } catch (err) {
        console.error('[WS] Failed to parse EDA message:', err.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[WS] EDA window disconnected: ${registeredWindowId} (${code} ${reason})`);
      if (registeredWindowId) {
        // Only drop the map entry if it is still ours.
        if (edaClients.get(registeredWindowId) === ws) {
          edaClients.delete(registeredWindowId);
        }
        if (activeEdaWindowId === registeredWindowId) {
          // Select another window if available
          activeEdaWindowId = edaClients.keys().next().value || null;
        }
        // Reject pending requests for this window
        for (const [id, pending] of pendingRequests) {
          if (pending.windowId === registeredWindowId) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`EDA window "${registeredWindowId}" disconnected`));
            pendingRequests.delete(id);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] EDA client error:', err.message);
    });
  } else {
    // Agent / AI client connection
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'execute') {
          try {
            const result = await executeOnEda(msg.code, msg.windowId);
            ws.send(JSON.stringify({
              type: 'result',
              id: msg.id,
              result,
              timestamp: Date.now(),
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'error',
              id: msg.id,
              error: err.message,
              timestamp: Date.now(),
            }));
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }));
        }
      } catch (err) {
        console.error('[WS] Failed to parse agent message:', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Agent client disconnected');
    });
  }
});

// ─── Core logic ─────────────────────────────────────────────────────

/**
 * Send a message to the connected EDA client
 * @param {string} windowId - Target EDA window ID
 * @param {object} msg - Message to send
 */
function sendToEda(windowId, msg) {
  const edaClient = edaClients.get(windowId);
  if (!edaClient) {
    throw new Error(`EDA window "${windowId}" not found in connected clients`);
  }
  if (edaClient.readyState !== 1) {
    throw new Error(`EDA window "${windowId}" is not in connected state (readyState: ${edaClient.readyState})`);
  }
  try {
    edaClient.send(JSON.stringify(msg));
  } catch (err) {
    throw new Error(`Failed to send to EDA window "${windowId}": ${err.message}`);
  }
}

/**
 * Execute JavaScript code on the EDA client and return the result
 * @param {string} code - JavaScript code to execute in EDA context
 * @param {string} [windowId] - Specific EDA window ID (uses active window if not specified)
 * @returns {Promise<any>}
 */
function executeOnEda(code, windowId) {
  return new Promise((resolve, reject) => {
    const targetWindowId = windowId || activeEdaWindowId;

    if (!targetWindowId) {
      reject(new Error('No EDA window connected. Please connect an EDA window first.'));
      return;
    }

    if (!edaClients.has(targetWindowId) || edaClients.get(targetWindowId).readyState !== 1) {
      reject(new Error(`EDA window "${targetWindowId}" is no longer connected. Please select another window.`));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer, windowId: targetWindowId });

    try {
      sendToEda(targetWindowId, {
        type: 'execute',
        id,
        code,
        windowId: targetWindowId,
        timestamp: Date.now(),
      });
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

/**
 * Handle messages received from EDA client
 * @param {object} msg - Message from EDA
 * @param {string} windowId - EDA window ID that sent the message
 */
function handleEdaMessage(msg, windowId) {
  if (msg.type === 'ping') {
    console.log(`[WS] Ping received from ${windowId}, sending pong`);
    const edaClient = edaClients.get(windowId);
    if (edaClient && edaClient.readyState === 1) {
      try {
        edaClient.send(JSON.stringify({
          type: 'pong',
          id: msg.id,
          timestamp: Date.now(),
        }));
      } catch (err) {
        console.error(`[WS] Failed to send pong to ${windowId}:`, err.message);
      }
    } else {
      console.warn(`[WS] Cannot send pong: window ${windowId} not found or disconnected`);
    }
    return;
  }

  if (msg.type === 'pong') {
    console.log('[EDA] Pong received from window', windowId, '- connection healthy');
    return;
  }

  if (msg.type === 'result' || msg.type === 'error') {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      // A result may only settle a request that was routed to this window.
      if (pending.windowId !== windowId) {
        console.warn(`[SEC] Dropped ${msg.type} for request ${msg.id} from unexpected window ${windowId}`);
        return;
      }
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.id);
      if (msg.type === 'result') {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || 'Unknown EDA error'));
      }
    }
    return;
  }

  console.log('[EDA] Unknown message type:', msg.type, 'from window:', windowId);
}

// ─── Start ──────────────────────────────────────────────────────────
async function start() {
  try {
    // ── Singleton check: exit if an identical bridge is already running ──
    if (process.env.EASYEDA_BRIDGE_NO_SINGLETON !== '1') {
      const existingPort = await findExistingInstance();
      if (existingPort) {
        console.log(`✅ Bridge server is already running on port ${existingPort}, no need to start another instance.`);
        process.exit(0);
      }
    }

    const port = await findAvailablePort();

    httpServer.listen(port, LISTEN_HOST, () => {
      try {
        writeSessionFile(port);
        sessionFileWritten = true;
      } catch (err) {
        // Without the token file the agent has no way to authenticate, so a
        // failure here is fatal unless the token was pinned via the environment.
        console.error(`\u274c Failed to write ${SESSION_FILE}: ${err.message}`);
        if (!process.env.EASYEDA_BRIDGE_TOKEN) {
          console.error('   Set EASYEDA_BRIDGE_TOKEN to supply a token out of band, or fix the path above.');
          process.exit(1);
        }
      }
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║         EasyEDA WebSocket Bridge Server                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${formatBannerLine('Port', port)}
${formatBannerLine('Listen Host', `${LISTEN_HOST} (localhost only)`)}
${formatBannerLine('Port Range', `${PORT_START}-${PORT_END}`)}
${formatBannerLine('Service ID', SERVICE_ID)}
║                                                              ║
║  HTTP API:    http://localhost:${port}                         ║
║  WS (EDA):   ws://localhost:${port}/eda                       ║
║  WS (Agent): ws://localhost:${port}/agent                     ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /health     - 健康检查 & EDA 连接状态                ║
║    POST /execute    - 执行代码 {"code": "..."}               ║
║                                                              ║
║  Handshake:                                                  ║
║    /health returns { service: "${SERVICE_ID}" }       ║
║    WS sends { type: "handshake", service: "..." }            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔐 Auth required on /execute, /eda-windows and ws://.../agent
   Token file : ${TOKEN_FILE}
   Session    : ${SESSION_FILE}
   Usage      : curl -H "Authorization: Bearer $(cat ${TOKEN_FILE})" ...
   Browser-origin requests and non-loopback Host headers are refused.
      `);
    });

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} became occupied. Restarting...`);
        httpServer.close();
        start(); // Retry
      } else {
        throw err;
      }
    });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

start();
