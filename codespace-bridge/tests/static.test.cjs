// 静态校验：脚本语法、DOM id 引用一致性、HTML 结构
// 用法：node codespace-bridge/tests/static.test.cjs [可选：html 路径]
const fs = require('fs');
const path = require('path');
const defaultIndex = path.resolve(__dirname, '..', '..', 'index.html');
const file = process.argv[2] ? path.resolve(process.argv[2]) : defaultIndex;
const html = fs.readFileSync(file, 'utf8');
let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

/* ---- 1. 提取脚本并做语法检查 ---- */
const scriptRe = /<script>([\s\S]*?)<\/script>/g;
let m, idx = 0, appJs = '';
while ((m = scriptRe.exec(html))) {
  idx++;
  if (m[1].length > 10000) appJs = m[1];   // 主脚本
}
log(!!appJs, '找到主脚本（' + appJs.length + ' 字符，共 ' + idx + ' 个 script 块）');
const tmp = path.join(require('os').tmpdir(), 'app_check.js');
fs.writeFileSync(tmp, appJs, 'utf8');
const { execFileSync } = require('child_process');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  log(true, '脚本语法检查通过（node --check）');
} catch (e) {
  log(false, '脚本语法错误：' + String(e.stderr || e.message).slice(0, 800));
}

/* ---- 2. id 引用一致性 ---- */
const declared = new Set();
for (const mm of html.matchAll(/\bid="([^"]+)"/g)) declared.add(mm[1]);
const RUNTIME_IDS = new Set(['scrollThumbTip']);   // 原代码里动态创建的节点
const refs = new Map();
for (const mm of appJs.matchAll(/\$\('([A-Za-z0-9_\-]+)'\)/g)) refs.set(mm[1], '$(...)');
for (const mm of appJs.matchAll(/\bon\('([A-Za-z0-9_\-]+)'/g)) refs.set(mm[1], "on(...)");
for (const mm of appJs.matchAll(/\b(?:set|val)\('([A-Za-z0-9_\-]+)'/g)) refs.set(mm[1], 'set/val');
const missing = [...refs.keys()].filter(k => !declared.has(k) && !RUNTIME_IDS.has(k));
log(missing.length === 0, '所有 $()/on()/set() 引用的 id 都存在' + (missing.length ? '：缺 ' + missing.join(', ') : ''));

/* 新增控件是否都被引用（防止写了 UI 没接线） */
const csIds = [...declared].filter(id => /^cfgCs|^btnCs|^csStatus$|^csInstallCmd$/.test(id));
const dead = csIds.filter(id => !refs.has(id));
log(dead.length === 0, 'Codespace 新增控件都已接线' + (dead.length ? '：未引用 ' + dead.join(', ') : ''));
console.log('   新增控件：' + csIds.join(', '));

/* ---- 3. 结构检查：settings pane 数量与闭合 ---- */
const panes = [...html.matchAll(/data-pane="([a-z]+)"/g)].map(x => x[1]);
const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(x => x[1]);
log(JSON.stringify(panes) === JSON.stringify(tabs), '设置页签与面板一一对应：tabs=' + tabs.join('/') + ' panes=' + panes.join('/'));

/* ---- 4. 工具定义与实现对齐 ---- */
const toolNames = [...appJs.matchAll(/name: '(cs_[a-z_]+)', description/g)].map(x => x[1]);
log(toolNames.length === 6, '新增 6 个 cs_* 工具定义：' + toolNames.join(', '));
const cases = [...appJs.matchAll(/case '(cs_[a-z_]+)': return await (csTool\w+)\(args\);/g)].map(x => x[1]);
log(cases.length === 6, 'executeTool 分发覆盖全部 cs_* 工具：' + cases.join(', '));
const impls = [...appJs.matchAll(/async function (csTool\w+)\(/g)].map(x => x[1]);
log(impls.length === 6, '实现函数齐全：' + impls.join(', '));
log(appJs.includes('CS_TOOL_NAMES.includes'), '未配置时过滤 cs_* 工具已接入 availTools');

/* ---- 5. 密钥字段与加密接入 ---- */
const sf = (appJs.match(/const SECRET_FIELDS = \[([^\]]+)\]/) || [])[1] || '';
log(/csToken/.test(sf) && /csBridgeToken/.test(sf), 'csToken / csBridgeToken 已加入 SECRET_FIELDS');
log(appJs.includes('add(cfg.csToken)'), '会话记录脱敏覆盖 Codespace 令牌');

/* ---- 6. HTML 基本闭合（粗略） ---- */
const opens = (html.match(/<div\b/g) || []).length;
const closes = (html.match(/<\/div>/g) || []).length;
log(opens === closes, '<div> 开合平衡：' + opens + ' / ' + closes);

console.log(fail ? `\n${fail} 项校验失败` : '\n全部静态校验通过');
process.exit(fail ? 1 : 0);
