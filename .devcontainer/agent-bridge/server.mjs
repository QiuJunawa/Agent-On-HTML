import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const PORT = Number(process.env.AGENT_BRIDGE_PORT || 8787);
const DIR = path.join(os.homedir(), '.agent-bridge');
const TOKEN_FILE = path.join(DIR, 'token');
const MAX_BODY = 8 * 1024 * 1024;
const MAX_OUT = 4 * 1024 * 1024;
const NL = String.fromCharCode(10);

function loadToken() {
  const env = String(process.env.AGENT_BRIDGE_TOKEN || '').trim();
  if (env) return env;
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch (e) {}
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch (e) {}
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
    fs.chmodSync(DIR, 0o700);
  } catch (e) {}
  return t;
}
const TOKEN = loadToken();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function authOk(req, url) {
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim() === TOKEN;
  return String(url.searchParams.get('token') || '') === TOKEN;
}

function expandP(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return os.homedir();
  if (s === '~') return os.homedir();
  if (s.indexOf('~/') === 0) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function runExec(payload) {
  const cmd = String(payload.cmd || '').trim();
  const cwd = expandP(payload.cwd || '');
  const timeout = Math.max(1000, Math.min(900000, Number(payload.timeout_ms) || 120000));
  return new Promise(function (resolve) {
    const started = Date.now();
    exec(cmd, { cwd: cwd, timeout: timeout, maxBuffer: MAX_OUT, shell: '/bin/bash' }, function (err, stdout, stderr) {
      const timedOut = !!(err && (err.killed || err.signal));
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const over = !!(err && String(err.message || '').indexOf('maxBuffer') >= 0);
      let serr = String(stderr || '');
      if (!serr && err && !over && err.message) serr = String(err.message);
      resolve({
        code: code, exit_code: code,
        stdout: String(stdout || ''), stderr: serr,
        duration_ms: Date.now() - started, cwd: cwd,
        timed_out: timedOut, truncated: over
      });
    });
  });
}

async function doLs(payload) {
  const dir = expandP(payload.path || '.');
  const all = payload.all === true;
  const list = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of list) {
    if (!all && d.name.startsWith('.')) continue;
    let size = 0;
    try { size = (await fs.promises.stat(path.join(dir, d.name))).size; } catch (e) {}
    entries.push({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: size });
  }
  entries.sort(function (a, b) { return a.type === b.type ? (a.name < b.name ? -1 : 1) : (a.type === 'dir' ? -1 : 1); });
  return { path: dir, entries: entries };
}

async function doRead(payload) {
  const p = expandP(payload.path);
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) throw new Error(p + ' 是目录，请用 /ls');
  const max = Math.max(1024, Math.min(4 * 1024 * 1024, Number(payload.max_bytes) || 400000));
  const take = Math.min(st.size, max);
  const buf = Buffer.alloc(take);
  const fh = await fs.promises.open(p, 'r');
  try { await fh.read(buf, 0, take, 0); } finally { await fh.close(); }
  const binary = buf.indexOf(0) >= 0;
  let content = binary ? '' : buf.toString('utf8');
  let totalLines = null;
  const s1 = Number(payload.start_line);
  const e1 = Number(payload.end_line);
  if (!binary) {
    const lines = content.split(NL);
    totalLines = lines.length;
    if (s1 >= 1 || e1 >= 1) {
      const from = s1 >= 1 ? s1 - 1 : 0;
      const to = e1 >= from + 1 ? Math.min(e1, lines.length) : lines.length;
      content = lines.slice(from, to).join(NL);
    }
  }
  return { path: p, size: st.size, content: content, binary: binary, total_lines: totalLines, truncated: st.size > take };
}

async function doWrite(payload) {
  const p = expandP(payload.path);
  const content = String(payload.content == null ? '' : payload.content);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  if (payload.append === true) await fs.promises.appendFile(p, content, 'utf8');
  else await fs.promises.writeFile(p, content, 'utf8');
  return { path: p, bytes: Buffer.byteLength(content, 'utf8') };
}

// /health：设置页「检测连接」就靠它。之前脚本根本没有这个路由，
// 浏览器请求 /health 拿到的是 404「未知接口」，检测永远失败而实际桥接是好的。
function healthInfo() {
  let user = '';
  let root = os.homedir();
  try { const u = os.userInfo(); user = u.username; root = u.homedir; } catch (e) {}
  return {
    ok: true, service: 'agent-bridge', version: 2,
    host: os.hostname(), user: user, root: root,
    node: process.version, port: PORT, cwd: process.cwd(), dir: DIR,
    uptime_ms: Math.round(process.uptime() * 1000)
  };
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  if (url.pathname === '/') { send(res, 200, { ok: true, service: 'agent-bridge', port: PORT }); return; }
  if (!authOk(req, url)) { send(res, 401, { ok: false, error: 'unauthorized' }); return; }
  try {
    // /health 不读请求体，GET 直接回；放在 authOk 之后，这样检测能同时验证令牌对不对
    if (url.pathname === '/health') { send(res, 200, healthInfo()); return; }
    const raw = await readBody(req);
    const payload = raw.trim() ? JSON.parse(raw) : {};
    if (url.pathname === '/exec') { send(res, 200, Object.assign({ ok: true }, await runExec(payload))); return; }
    if (url.pathname === '/ls') { send(res, 200, Object.assign({ ok: true }, await doLs(payload))); return; }
    if (url.pathname === '/read') { send(res, 200, Object.assign({ ok: true }, await doRead(payload))); return; }
    if (url.pathname === '/write') { send(res, 200, Object.assign({ ok: true }, await doWrite(payload))); return; }
    send(res, 404, { ok: false, error: '未知接口 ' + url.pathname });
  } catch (e) {
    send(res, 200, { ok: false, error: (e && e.message) || String(e) });
  }
});
server.listen(PORT, '0.0.0.0', function () {
  console.log('[agent-bridge] 已监听 0.0.0.0:' + PORT);
  console.log('[agent-bridge] 令牌文件：' + TOKEN_FILE);
  console.log('[agent-bridge] 桥接令牌：' + TOKEN);
  console.log('把上一行这串令牌填进「设置 → Codespace → 桥接令牌」。');
});
