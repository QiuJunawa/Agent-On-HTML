#!/usr/bin/env node
/**
 * Agent-On-HTML · Codespace Bridge  v1.0
 * ---------------------------------------------------------------
 * 在 GitHub Codespace（或任意 Linux / macOS 主机）里运行的零依赖 HTTP 桥接服务，
 * 让浏览器里的 Agent 能真正执行命令、读写真实文件、起服务拿公网预览地址。
 *
 * 启动：
 *   node codespace-bridge/server.mjs
 *   CS_BRIDGE_PORT=8787 CS_BRIDGE_TOKEN=xxxx node codespace-bridge/server.mjs
 *
 * 环境变量：
 *   CS_BRIDGE_PORT          监听端口，默认 8787
 *   CS_BRIDGE_TOKEN         访问令牌；不填则自动生成并写入 ~/.agent-bridge.token
 *   CS_BRIDGE_TOKEN_FILE    令牌文件位置，默认 ~/.agent-bridge.token
 *   CS_BRIDGE_ROOT          文件操作根目录，默认当前工作目录
 *   CS_BRIDGE_MAX_OUT       单次命令输出上限（字节），默认 120000
 *   CS_BRIDGE_ALLOW_ESCAPE  设为 1 时允许文件操作越过 CS_BRIDGE_ROOT
 *   CS_BRIDGE_DISABLE_EXEC  设为 1 时禁用 /exec（只保留文件读写）
 *
 * 安全模型：令牌是唯一门禁。端口必须仅在你信任的场景下设为 Public。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VERSION = '1.0.0';
const PORT = clampInt(process.env.CS_BRIDGE_PORT || process.env.PORT || 8787, 1, 65535, 8787);
const ROOT = path.resolve(process.env.CS_BRIDGE_ROOT || process.cwd());
const MAX_OUT = clampInt(process.env.CS_BRIDGE_MAX_OUT || 120000, 4000, 4000000, 120000);
const ALLOW_ESCAPE = process.env.CS_BRIDGE_ALLOW_ESCAPE === '1';
const DISABLE_EXEC = process.env.CS_BRIDGE_DISABLE_EXEC === '1';
const TOKEN_FILE = process.env.CS_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.agent-bridge.token');
const BODY_LIMIT = 16 * 1024 * 1024;   // 单次请求体上限 16MB

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------------- 令牌 */
function loadOrCreateToken() {
  const fromEnv = String(process.env.CS_BRIDGE_TOKEN || '').trim();
  if (fromEnv) {
    try { fs.writeFileSync(TOKEN_FILE, fromEnv, { mode: 0o600 }); } catch (_) {}
    return { token: fromEnv, generated: false };
  }
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return { token: saved, generated: false };
  } catch (_) {}
  const fresh = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 }); } catch (_) {}
  return { token: fresh, generated: true };
}

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const { token: TOKEN, generated: TOKEN_IS_NEW } = loadOrCreateToken();

/* ---------------------------------------------------------------- 工具函数 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store'
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('请求体过大（>' + (BODY_LIMIT / 1048576) + 'MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function safePath(input) {
  const raw = String(input == null || input === '' ? '.' : input);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  if (!ALLOW_ESCAPE) {
    const rel = path.relative(ROOT, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep)) {
      throw new Error('路径越界：' + abs + ' 不在根目录 ' + ROOT + ' 内（如确需访问，设置 CS_BRIDGE_ALLOW_ESCAPE=1）');
    }
  }
  return abs;
}

function clip(text, limit) {
  const s = String(text || '');
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit), truncated: true };
}

/* ---------------------------------------------------------------- /exec */
function childEnv() {
  return {
    ...process.env,
    // 让脚本里的输出不要带 ANSI 颜色控制符，方便前端展示
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // 尽量让子进程按 UTF-8 输出（Codespace 原生是 UTF-8，Windows 上靠下面两行兜底）
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    LANG: process.env.LANG || 'C.UTF-8'
  };
}

/* Windows 的 cmd 默认用 OEM 代码页（GBK/CP437），会把中文输出变成乱码；
 * 在命令前切到 65001，Linux/macOS 不受影响。 */
function shellCommand(cmd) {
  if (process.platform === 'win32') return 'chcp 65001 >nul & ' + cmd;
  return cmd;
}

/* 子进程输出解码：优先 UTF-8；Windows 上偶尔是 GBK（cmd 代码页），做一次兜底 */
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch (_) { return buf.toString('utf8'); }
  }
}

function runExec({ cmd, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const workdir = (() => { try { return safePath(cwd || ROOT); } catch (_) { return ROOT; } })();
    const sink = () => ({ chunks: [], bytes: 0, truncated: false });
    const out = sink(), err = sink();
    let child;
    try {
      child = spawn(shellCommand(String(cmd)), {
        shell: true,
        cwd: workdir,
        env: childEnv(),
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (e) {
      return resolve({ ok: true, code: -1, stdout: '', stderr: '启动失败：' + e.message, cwd: workdir, duration_ms: 0, truncated: false, timed_out: false });
    }

    let timedOut = false, settled = false;
    const collect = (target) => (buf) => {
      if (target.bytes >= MAX_OUT) { target.truncated = true; return; }
      const room = MAX_OUT - target.bytes;
      const piece = buf.length > room ? buf.subarray(0, room) : buf;
      target.chunks.push(piece);
      target.bytes += piece.length;
      if (piece.length < buf.length) target.truncated = true;
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: true,
        code: code == null ? -1 : code,
        stdout: decodeOutput(Buffer.concat(out.chunks)),
        stderr: decodeOutput(Buffer.concat(err.chunks)),
        cwd: workdir,
        duration_ms: Date.now() - started,
        truncated: out.truncated || err.truncated,
        timed_out: timedOut
      });
    };

    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          // Windows 上 node 的 kill 只终止 cmd.exe，孙进程（如 ping、长任务）会拖住管道；
          // 用 taskkill /T 连整棵进程树一起干掉。
          if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
          try { child.kill(); } catch (_) {}
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        }
      } catch (_) {}
      // 兜底：即使管道没关干净，也别让请求一直挂着
      const grace = setTimeout(() => finish(null), 3000);
      if (grace.unref) grace.unref();
    };

    const timer = setTimeout(() => { timedOut = true; killTree(); }, Math.max(1000, timeoutMs));
    child.on('error', (e) => { err.chunks.push(Buffer.from('\n' + e.message)); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

/* ---------------------------------------------------------------- 路由 */
const routes = {
  'GET /health': async () => ({
    ok: true,
    version: VERSION,
    host: os.hostname(),
    user: (os.userInfo().username || ''),
    platform: process.platform + ' ' + os.arch(),
    node: process.version,
    root: ROOT,
    cwd: process.cwd(),
    codespace: process.env.CODESPACE_NAME || process.env.GITHUB_CODESPACE_NAME || '',
    exec_enabled: !DISABLE_EXEC,
    uptime_s: Math.round(process.uptime())
  }),

  'POST /exec': async (body) => {
    if (DISABLE_EXEC) throw new Error('exec 已被禁用（CS_BRIDGE_DISABLE_EXEC=1）');
    const cmd = String(body.cmd || body.command || '').trim();
    if (!cmd) throw new Error('缺少 cmd');
    const timeoutMs = clampInt(body.timeout_ms || 120000, 1000, 15 * 60 * 1000, 120000);
    return runExec({ cmd, cwd: body.cwd, timeoutMs });
  },

  'POST /ls': async (body) => {
    const target = safePath(body.path || ROOT);
    const st = await fsp.stat(target);
    if (!st.isDirectory()) throw new Error('不是目录：' + target);
    const names = await fsp.readdir(target);
    const entries = [];
    for (const name of names.sort()) {
      if (!body.all && name.startsWith('.') && name !== '.env') continue;
      try {
        const s = await fsp.lstat(path.join(target, name));
        entries.push({
          name,
          type: s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file',
          size: s.isDirectory() ? 0 : s.size,
          mtime: s.mtimeMs
        });
      } catch (_) { entries.push({ name, type: 'unknown', size: 0, mtime: 0 }); }
    }
    return { ok: true, path: target, entries };
  },

  'POST /read': async (body) => {
    const target = safePath(body.path || '');
    const st = await fsp.stat(target);
    if (st.isDirectory()) throw new Error('是目录：' + target);
    const maxBytes = clampInt(body.max_bytes || 400000, 1024, 8 * 1024 * 1024, 400000);
    const buf = await fsp.readFile(target);
    const sliced = buf.subarray(0, maxBytes);
    const text = sliced.toString('utf8');
    const binary = text.includes('\u0000');
    if (binary) {
      return { ok: true, path: target, binary: true, size: st.size, content: '', truncated: true, lines: 0 };
    }
    let lines = text.split('\n');
    const totalLines = st.size > maxBytes ? null : lines.length;
    const startLine = Math.max(1, parseInt(body.start_line, 10) || 1);
    const endLine = parseInt(body.end_line, 10) || lines.length;
    if (startLine > 1 || endLine < lines.length) lines = lines.slice(startLine - 1, endLine);
    const out = lines.join('\n');
    const clipped = clip(out, maxBytes);
    return {
      ok: true,
      path: target,
      size: st.size,
      content: clipped.text,
      truncated: clipped.truncated || st.size > maxBytes,
      start_line: startLine,
      end_line: endLine,
      total_lines: totalLines
    };
  },

  'POST /write': async (body) => {
    const target = safePath(body.path || '');
    const content = String(body.content == null ? '' : body.content);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      if (body.mkdir === false) throw new Error('父目录不存在：' + dir);
      await fsp.mkdir(dir, { recursive: true });
    }
    if (body.append) await fsp.appendFile(target, content, 'utf8');
    else await fsp.writeFile(target, content, 'utf8');
    const st = await fsp.stat(target);
    return { ok: true, path: target, bytes: st.size, charset: 'utf8', append: !!body.append };
  },

  'POST /append': async (body) => routes['POST /write']({ ...body, append: true })
};

/* ---------------------------------------------------------------- 服务 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const routeKey = req.method + ' ' + url.pathname.replace(/\/+$/, '').toLowerCase();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const fromQuery = url.searchParams.get('token') || '';
  const provided = bearer || fromQuery;

  let payload;
  if (!tokenOk(provided)) {
    sendJson(res, 401, { ok: false, error: '令牌无效：请在 Agent 设置里填入 ~/.agent-bridge.token 的内容' });
    return;
  }

  const handler = routes[routeKey];
  if (!handler) {
    sendJson(res, 404, { ok: false, error: '未知接口：' + req.method + ' ' + url.pathname });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(body);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  const csName = process.env.CODESPACE_NAME || process.env.GITHUB_CODESPACE_NAME || '';
  const publicUrl = csName ? `https://${csName}-${PORT}.${domain}` : '';
  console.log('┌───────────────────────────────────────────────');
  console.log('│ Agent-On-HTML · Codespace Bridge v' + VERSION);
  console.log('├───────────────────────────────────────────────');
  console.log('│ 本地监听   http://127.0.0.1:' + PORT);
  if (publicUrl) {
    console.log('│ 公开地址   ' + publicUrl);
    console.log('│             ↑ 需要在「端口」面板把 ' + PORT + ' 设为 Public');
  }
  console.log('│ 根目录     ' + ROOT);
  console.log('│ 令牌文件   ' + TOKEN_FILE);
  console.log('│ 令牌       ' + TOKEN + (TOKEN_IS_NEW ? '   ← 新生成，粘进 Agent 设置 → Codespace' : ''));
  console.log('└───────────────────────────────────────────────');
  if (TOKEN_IS_NEW) console.log('\n提示：令牌已保存，下次启动沿用同一个令牌，不必重新填。\n');
});

server.on('error', (e) => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { server.close(); } catch (_) {} process.exit(0); });
}
