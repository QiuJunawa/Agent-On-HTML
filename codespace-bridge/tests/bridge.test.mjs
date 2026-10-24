// 桥接服务端到端测试（只做 HTTP 调用，不 spawn 子进程）
const BASE = 'http://127.0.0.1:8799';
const TOKEN = 'testtoken123';
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push('PASS ' + name); }
  else { fail++; results.push('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
async function call(path, body, opts = {}) {
  const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
  if (opts.auth !== false) headers['Authorization'] = 'Bearer ' + (opts.token || TOKEN);
  const init = { method: body ? 'POST' : 'GET', headers };
  if (body) init.body = JSON.stringify(body);
  const resp = await fetch(BASE + path, init);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: resp.status, json, text, headers: resp.headers };
}

(async () => {
  // 1. health 带 header
  let r = await call('/health');
  check('health + bearer', r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 120));
  check('health 暴露 root/cwd', !!(r.json && r.json.root && r.json.cwd));

  // 2. 无令牌 401
  r = await call('/health', null, { auth: false });
  check('无令牌应 401', r.status === 401, 'got ' + r.status);

  // 3. 错误令牌 401
  r = await call('/health', null, { token: 'wrong' });
  check('错误令牌应 401', r.status === 401, 'got ' + r.status);

  // 4. query 令牌回退（模拟浏览器无法带 header 时的降级）
  r = await fetch(BASE + '/health?token=' + TOKEN).then(async x => ({ status: x.status, json: await x.json() }));
  check('query 令牌可用', r.status === 200 && r.json.ok === true);

  // 5. CORS 预检
  const pre = await fetch(BASE + '/exec', { method: 'OPTIONS', headers: { Origin: 'https://qiujunawa.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  const acao = pre.headers.get('access-control-allow-origin');
  const acah = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
  check('OPTIONS 204 + ACAO *', pre.status === 204 && acao === '*', pre.status + ' ' + acao);
  check('OPTIONS 允许 authorization 头', acah.includes('authorization'), acah);
  check('普通响应也带 ACAO', (await fetch(BASE + '/health', { headers: { Authorization: 'Bearer ' + TOKEN } })).headers.get('access-control-allow-origin') === '*');

  // 6. exec 基本命令 + UTF-8
  r = await call('/exec', { cmd: 'echo hello-bridge && echo 中文测试' });
  check('exec 返回码 0', r.json && r.json.code === 0, r.text.slice(0, 200));
  check('exec 捕获 stdout', /hello-bridge/.test(r.json.stdout || ''), r.json.stdout);
  check('exec UTF-8 正确', /中文测试/.test(r.json.stdout || ''), JSON.stringify(r.json.stdout));

  // 7. exec 指定 cwd
  const isWin = process.platform === 'win32';
  r = await call('/exec', { cmd: isWin ? 'cd' : 'pwd', cwd: 'codespace-bridge' });
  check('exec 支持 cwd', /codespace-bridge/.test((r.json.stdout || '').replace(/\\/g, '/')), r.json.stdout + r.json.stderr);

  // 8. exec 超时
  const t0 = Date.now();
  r = await call('/exec', { cmd: isWin ? 'ping -n 10 127.0.0.1 >nul' : 'sleep 10', timeout_ms: 1200 });
  check('exec 超时被杀', r.json && r.json.timed_out === true, JSON.stringify(r.json).slice(0, 200));
  check('exec 超时不拖太久', Date.now() - t0 < 6000, (Date.now() - t0) + 'ms');

  // 9. 非零退出码
  r = await call('/exec', { cmd: 'exit 3' });
  check('exec 非零退出码透传', r.json.code === 3, String(r.json.code));

  // 10. ls
  r = await call('/ls', { path: '.' });
  const names = (r.json.entries || []).map(e => e.name);
  check('ls 列出目录', r.json.ok && names.includes('index.html'), names.join(','));

  // 11. write + read 往返
  r = await call('/write', { path: 'bridge-test/out.txt', content: '第一行\n第二行\n第三行' });
  check('write 成功', r.json.ok === true && r.json.bytes > 0, r.text.slice(0, 120));
  r = await call('/read', { path: 'bridge-test/out.txt' });
  check('read 往返一致', r.json.content === '第一行\n第二行\n第三行', JSON.stringify(r.json.content));
  check('read 行数', r.json.total_lines === 3, String(r.json.total_lines));

  // 12. read 行范围
  r = await call('/read', { path: 'bridge-test/out.txt', start_line: 2, end_line: 3 });
  check('read 行范围', r.json.content === '第二行\n第三行', JSON.stringify(r.json.content));

  // 13. append
  await call('/append', { path: 'bridge-test/out.txt', content: '\n第四行' });
  r = await call('/read', { path: 'bridge-test/out.txt' });
  check('append 生效', /第四行/.test(r.json.content || ''), JSON.stringify(r.json.content));

  // 14. 越界路径拒绝
  r = await call('/read', { path: '../../../etc/passwd' });
  check('越界读被拒绝', r.status === 500 && /越界/.test(r.json.error || ''), r.text.slice(0, 160));

  // 15. 未知接口
  r = await call('/nope');
  check('未知接口 404', r.status === 404, String(r.status));

  // 16. 大输出截断（用文件模拟，避免依赖目标机器上装了什么）
  await call('/write', { path: 'bridge-test/big.txt', content: 'x'.repeat(300000) });
  r = await call('/exec', { cmd: isWin ? 'type bridge-test\\big.txt' : 'cat bridge-test/big.txt' });
  check('大输出标记截断', r.json.truncated === true, 'truncated=' + r.json.truncated + ' len=' + (r.json.stdout || '').length);

  // 清理测试产生的目录
  try {
    await call('/exec', { cmd: isWin ? 'rmdir /s /q bridge-test' : 'rm -rf bridge-test' });
  } catch (_) {}

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：' + e.stack); process.exit(2); });
