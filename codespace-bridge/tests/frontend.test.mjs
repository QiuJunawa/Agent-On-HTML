// 前端 Codespace 模块的运行时测试：抽出 index.html 里的 4c 段落，在 stub 环境里真跑（对着本地桥接）
// 用法：先起桥接 CS_BRIDGE_PORT=8799 CS_BRIDGE_TOKEN=testtoken123 node codespace-bridge/server.mjs
//      再跑 node codespace-bridge/tests/frontend.test.mjs
import fs from 'node:fs';

const INDEX_URL = new URL('../../index.html', import.meta.url);
const html = fs.readFileSync(INDEX_URL, 'utf8');
const start = html.indexOf('/* =========================================================\n *  4c. GitHub Codespaces');
const end = html.indexOf('/* =========================================================\n *  5. 通信层');
if (start < 0 || end < 0) { console.error('无法定位 4c 模块'); process.exit(2); }
const moduleCode = html.slice(start, end);

const prelude = `
const __log = (ok, msg) => { if (!ok) { globalThis.__fail++; console.log('FAIL ' + msg); } else console.log('PASS ' + msg); };
globalThis.__fail = 0;
let cfg = { csToken: '', csName: '', csBridgePort: 8787, csBridgeToken: '', csBridgeUrl: '', csWorkdir: '', csTimeoutSec: 120, csDomain: 'app.github.dev', csRequireConfirm: true };
const MAX_READ = 30000;
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = n => { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / 1024 / 1024).toFixed(2) + ' MB'; };
const toasts = [];
const toast = (m, t) => { toasts.push((t || 'info') + ': ' + m); };
let CONFIRM_ANSWER = true;
const confirmCalls = [];
const customConfirm = async (msg, op) => { confirmCalls.push({ msg, op }); return CONFIRM_ANSWER; };
let saveCfgCalls = 0;
const saveCfg = async () => { saveCfgCalls++; };
const vfsWrites = [];
let refreshCalls = 0;
const refreshFS = async () => { refreshCalls++; };
const undoPushes = [];
const pushUndo = (op) => { undoPushes.push(op); };
const VFS = {
  norm: p => { let s = String(p == null ? '/' : p).trim().replace(/\\\\/g, '/'); if (!s.startsWith('/')) s = '/' + s; s = s.replace(/\\/+/g, '/'); if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); return s; },
  writeFile: async (p, c) => { vfsWrites.push({ p, c }); },
  stat: (p) => (vfsWrites.some(w => w.p === p) ? { type: 'file' } : null),
  getContent: async (p) => { const hit = vfsWrites.filter(w => w.p === p); return hit.length ? hit[hit.length - 1].c : null; }
};
const form = {};
const el = (id, tag) => ({ id, tag: tag || 'input', value: '', checked: false, textContent: '', innerHTML: '', _sel: [] });
const dom = {};
for (const id of ['cfgCsToken','cfgCsName','cfgCsBridgePort','cfgCsWorkdir','cfgCsBridgeToken','cfgCsBridgeUrl','cfgCsTimeoutSec','cfgCsDomain','cfgCsRequireConfirm','csStatus','csInstallCmd','btnCsRefresh','btnCsTest','btnCsStartCs','btnCsStopCs','btnCsPublish','btnCsCopyCmd']) {
  dom[id] = el(id, id === 'cfgCsName' ? 'select' : id.startsWith('btn') ? 'button' : 'input');
}
const document = { getElementById: (id) => dom[id] || null };
const $ = (id) => dom[id] || null;

/* 拦截 api.github.com，用假响应测 GitHub 层；其它请求（本地桥接）照旧走真 fetch */
const realFetch = globalThis.fetch;
const ghCalls = [];
let ghHandler = async () => { throw new Error('fetch failed'); };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.github.com')) {
    const method = (init && init.method) || 'GET';
    const headers = (init && init.headers) || {};
    ghCalls.push({ url: u, method, headers, body: init && init.body });
    const r = await ghHandler(u, init);
    return { status: r.status, ok: r.ok, headers: new Map(), text: async () => r.body };
  }
  return realFetch(url, init);
};
`;

const tests = `
/* ---------- 1. URL 推导 ---------- */
cfg.csName = 'fuzzy-robot-abc123'; cfg.csBridgePort = 8787; cfg.csBridgeUrl = '';
__log(csDeriveUrl(8787) === 'https://fuzzy-robot-abc123-8787.app.github.dev', '推导桥接地址：' + csDeriveUrl(8787));
__log(csPublicUrl(8000) === 'https://fuzzy-robot-abc123-8000.app.github.dev', '推导预览地址：' + csPublicUrl(8000));
cfg.csBridgeUrl = 'https://custom.example.com/';
__log(csPublicUrl(8787) === 'https://custom.example.com', '显式地址优先且去掉尾斜杠');
__log(csPublicUrl(3000) === 'https://fuzzy-robot-abc123-3000.app.github.dev', '显式地址只覆盖桥接端口');
cfg.csBridgeUrl = '';

/* ---------- 2. 就绪判断 ---------- */
__log(csToolsReady() === false, '没有桥接令牌 → 工具未就绪');
cfg.csBridgeToken = 'testtoken123';
__log(csToolsReady() === true, '有名称 + 令牌 → 工具就绪');
cfg.csName = ''; cfg.csBridgeUrl = '';
__log(csToolsReady() === false, '只有令牌没有目标 → 仍未就绪');

/* ---------- 3. 对着本地桥接真跑 ---------- */
cfg.csName = ''; cfg.csBridgeUrl = 'http://127.0.0.1:8799'; cfg.csBridgeToken = 'testtoken123';
const health = await csBridgeRequest('/health', null, { force: true });
__log(health.ok === true && !!health.root, 'health 通：' + health.platform + ' / ' + health.root);

cfg.csBridgeToken = 'wrong-token';
let err401 = '';
try { await csBridgeRequest('/health', null, { force: true }); } catch (e) { err401 = e.message; }
__log(/401|令牌/.test(err401), '错误令牌给出可读报错：' + err401.slice(0, 60));
cfg.csBridgeToken = 'testtoken123';

/* ---------- 4. cs_exec ---------- */
const ex = await csToolExec({ command: 'echo hi-from-agent' });
__log(/hi-from-agent/.test(ex) && /退出码 0/.test(ex), 'cs_exec 输出正确');
__log(confirmCalls.length === 1 && confirmCalls[0].op === 'cs_exec', 'cs_exec 执行前弹窗确认');
cfg.csRequireConfirm = false;
const ex2 = await csToolExec({ command: 'exit 4' });
__log(/退出码 4/.test(ex2), 'cs_exec 透传退出码');
CONFIRM_ANSWER = false;
cfg.csRequireConfirm = true;
const ex3 = await csToolExec({ command: 'echo should-not-run' });
__log(/拒绝/.test(ex3), '用户拒绝后不执行');
CONFIRM_ANSWER = true;

/* ---------- 5. cs_ls / cs_write / cs_read ---------- */
const ls = await csToolLs({ path: '.' });
__log(/index\\.html/.test(ls) && /📄 文件/.test(ls), 'cs_ls 列出目录');
await csToolWrite({ path: 'bridge-test/fe.txt', content: '甲\\n乙\\n丙' });
const rd = await csToolRead({ path: 'bridge-test/fe.txt' });
__log(/甲/.test(rd) && /总行数 3/.test(rd), 'cs_write + cs_read 往返');
const part = await csToolRead({ path: 'bridge-test/fe.txt', start_line: 2, end_line: 3 });
__log(/乙/.test(part) && !/甲/.test(part), 'cs_read 行范围生效');

/* ---------- 6. cs_download 进 VFS ---------- */
const dl = await csToolDownload({ path: 'bridge-test/fe.txt', vfs_path: '/downloads/fe.txt' });
__log(vfsWrites.length === 1 && vfsWrites[0].p === '/downloads/fe.txt' && /甲/.test(vfsWrites[0].c), 'cs_download 写入 VFS');
__log(refreshCalls === 1, 'cs_download 刷新文件树');
__log(undoPushes.length === 1 && undoPushes[0].type === 'write_file' && undoPushes[0].before === null, 'cs_download 记录撤销栈（新文件 before=null）');
__log(/已下载/.test(dl), 'cs_download 返回摘要');

/* ---------- 7. cs_serve（无 GitHub Token 时跳过 API，仍给出地址） ---------- */
cfg.csName = 'test-cs';
const sv = await csToolServe({ dir: '.', port: 8123 });
__log(/静态服务已在 Codespace 启动/.test(sv), 'cs_serve 返回启动结果');
__log(/test-cs-8123\\.app\\.github\\.dev/.test(sv), 'cs_serve 给出预览地址：' + (sv.match(/https:\\/\\/\\S+/) || [''])[0]);
cfg.csName = ''; cfg.csBridgeUrl = 'http://127.0.0.1:8799';

/* ---------- 8. 未配置时的提示 ---------- */
const bakToken = cfg.csBridgeToken;
cfg.csBridgeToken = '';
cfg.csName = '';
const notReady = await csToolExec({ command: 'echo x' });
__log(/还没配置/.test(notReady), '未配置时工具返回引导文案（不是抛异常）');
cfg.csBridgeToken = bakToken;

/* ---------- 9. 表单回填 / 读取 ---------- */
cfg.csToken = 'ghp_demo'; cfg.csName = 'cs-a'; cfg.csWorkdir = '/workspaces/demo'; cfg.csBridgeToken = 'tok';
cfg.csBridgePort = 9001; cfg.csTimeoutSec = 60; cfg.csDomain = 'example.dev'; cfg.csRequireConfirm = false;
csFillForm();
__log(dom.cfgCsToken.value === 'ghp_demo' && dom.cfgCsName.value === 'cs-a' && String(dom.cfgCsBridgePort.value) === '9001', 'csFillForm 回填基本字段');
__log(dom.cfgCsRequireConfirm.checked === false, 'csFillForm 回填复选框');
__log(/curl -fsSL/.test(dom.csInstallCmd.textContent) && /agent-bridge\\.mjs/.test(dom.csInstallCmd.textContent), '安装命令已渲染');
// 改表单再读回
dom.cfgCsToken.value = 'ghp_new'; dom.cfgCsBridgePort.value = '9999'; dom.cfgCsBridgeUrl.value = 'http://127.0.0.1:8799/'; dom.cfgCsRequireConfirm.checked = true;
dom.cfgCsName.value = ''; dom.cfgCsName._sel = [];
csReadForm();
__log(cfg.csToken === 'ghp_new' && cfg.csBridgePort === 9999 && cfg.csBridgeUrl === 'http://127.0.0.1:8799', 'csReadForm 读回并规整地址');
__log(cfg.csRequireConfirm === true, 'csReadForm 读回复选框');

/* ---------- 10. 检测连接按钮 ---------- */
cfg.csBridgeUrl = 'http://127.0.0.1:8799'; cfg.csBridgeToken = 'testtoken123'; cfg.csName = '';
csFillForm();
await csUiTest();
__log(/桥接正常/.test(dom.csStatus.innerHTML), '检测连接把状态写进设置页：' + dom.csStatus.innerHTML.slice(0, 90));
__log(saveCfgCalls > 0, '检测通过后保存配置');

/* ---------- 11. 连接失败的可读报错 ---------- */
cfg.csBridgeUrl = 'http://127.0.0.1:9/';
let failMsg = '';
try { await csBridgeRequest('/health', null, { force: true }); } catch (e) { failMsg = e.message; }
__log(/连不上 Codespace 桥接/.test(failMsg) && /排查顺序/.test(failMsg), '连不上时给出排查清单');

/* ---------- 12. GitHub API 前置校验与错误包装 ---------- */
cfg.csToken = '';
let noTokenMsg = '';
try { await csGhList(); } catch (e) { noTokenMsg = e.message; }
__log(/未配置 GitHub Token/.test(noTokenMsg), '没有 Token 时直接给出可操作提示');

cfg.csToken = 'ghp_bogus_token_for_test';
let apiMsg = '';
try { await csGhList(); } catch (e) { apiMsg = e.message; }
__log(/GitHub API|GitHub Token|拒绝访问|请求 GitHub API 失败/.test(apiMsg), 'GitHub API 异常被包装成可读报错：' + apiMsg.slice(0, 70));
cfg.csToken = '';

/* ---------- 13. GitHub API 层（mock fetch） ---------- */
ghHandler = async () => ({ status: 200, ok: true, body: JSON.stringify({ codespaces: [
  { name: 'cs-one', state: 'Available', repository: { full_name: 'me/repo' }, machine: { display_name: '4-core' } },
  { name: 'cs-two', state: 'Stopped', repository: { full_name: 'me/repo2' }, machine: { name: '2-core' } }
] }) });
ghCalls.length = 0;
cfg.csToken = 'ghp_mock';
const list = await csGhList();
__log(list.length === 2 && list[0].repo === 'me/repo' && list[1].machine === '2-core', 'csGhList 解析列表（display_name → name 兜底）');
__log(ghCalls[0].url === 'https://api.github.com/user/codespaces?per_page=100' && ghCalls[0].method === 'GET', '列表请求路径正确');
__log(/Bearer ghp_mock/.test(ghCalls[0].headers.Authorization) && ghCalls[0].headers.Accept === 'application/vnd.github+json', 'API 请求头正确');

ghCalls.length = 0;
ghHandler = async () => ({ status: 200, ok: true, body: '{"state":"Available"}' });
await csGhStart('cs one/1');
__log(ghCalls[0].method === 'POST' && ghCalls[0].url === 'https://api.github.com/user/codespaces/cs%20one%2F1/start', 'csGhStart 编码名称并 POST：' + ghCalls[0].url);

ghCalls.length = 0;
await csGhMakePublic('cs-one', 8787);
__log(ghCalls[0].method === 'PATCH' && JSON.parse(ghCalls[0].body).visibility === 'public'
  && ghCalls[0].url === 'https://api.github.com/user/codespaces/cs-one/ports/8787', 'csGhMakePublic PATCH visibility=public');

ghHandler = async () => ({ status: 200, ok: true, body: JSON.stringify({ ports: [{ sourcePort: 8787, visibility: 'public' }] }) });
const portsObj = await csGhPorts('cs-one');
__log(portsObj.length === 1 && portsObj[0].sourcePort === 8787, 'csGhPorts 兼容 {ports:[]} 包装');
ghHandler = async () => ({ status: 200, ok: true, body: '[]' });
const portsArr = await csGhPorts('cs-one');
__log(Array.isArray(portsArr) && portsArr.length === 0, 'csGhPorts 兼容裸数组');

ghHandler = async () => ({ status: 403, ok: false, body: '{"message":"Resource not accessible by personal access token"}' });
let msg403 = '';
try { await csGhStart('cs-one'); } catch (e) { msg403 = e.message; }
__log(/拒绝访问/.test(msg403) && /codespace/.test(msg403), '403 映射成权限提示：' + msg403.slice(0, 70));

/* ---------- 14. 刷新列表：填下拉 + 状态文案 + 自动保存 ---------- */
ghCalls.length = 0;
ghHandler = async () => ({ status: 200, ok: true, body: JSON.stringify({ codespaces: [{ name: 'cs-one', state: 'Available', repository: { full_name: 'me/repo' } }] }) });
dom.cfgCsToken.value = 'ghp_mock';
dom.cfgCsName.value = '';
await csUiRefresh();
__log(/cs-one/.test(dom.cfgCsName.innerHTML) && /Available/.test(dom.cfgCsName.innerHTML), '刷新列表填充下拉选项');
__log(/已加载 1 个/.test(dom.csStatus.innerHTML), '刷新列表更新状态文案');
cfg.csToken = '';

console.log(globalThis.__fail ? '\\n' + globalThis.__fail + ' 项失败' : '\\n全部前端逻辑测试通过');
if (globalThis.__fail) process.exit(1);

/* 清理测试写出的远端目录 */
try {
  cfg.csBridgeUrl = 'http://127.0.0.1:8799'; cfg.csBridgeToken = 'testtoken123'; cfg.csName = '';
  await csBridgeRequest('/exec', { cmd: process.platform === 'win32' ? 'rmdir /s /q bridge-test' : 'rm -rf bridge-test', timeout_ms: 15000 });
} catch (e) { /* 忽略清理失败 */ }
`;

const code = `(async () => {\n${prelude}\n${moduleCode}\n${tests}\n})().catch(e => { console.error('测试异常：' + (e && e.stack || e)); process.exit(2); });`;
const tmpUrl = new URL('./.tmp_frontend.mjs', import.meta.url);
fs.writeFileSync(tmpUrl, code, 'utf8');
try { await import(tmpUrl.href); } finally { try { fs.unlinkSync(tmpUrl); } catch (_) {} }
