// 通用 XML 式工具调用解析器的测试：直接从 index.html 抽出实现区域，对着真实代码跑
// 用法：node tests/xml-tool-filter.test.mjs
import fs from 'node:fs';

const INDEX_URL = new URL('../index.html', import.meta.url);
const html = fs.readFileSync(INDEX_URL, 'utf8');
const start = html.indexOf('/* ---------- 通用 XML 式工具调用解析');
const end = html.indexOf('async function streamChat() {');
if (start < 0 || end < 0) { console.error('无法定位 XML 过滤器区域'); process.exit(2); }
const moduleCode = html.slice(start, end);

const prelude = `
let __fail = 0;
const __log = (ok, msg) => { if (!ok) { __fail++; console.log('FAIL ' + msg); } else console.log('PASS ' + msg); };
const TOOLS = [
  'list_files','read_file','edit_file','write_file','append_file','delete_path','move_path','create_dir',
  'search_files','fetch_url','download_url','route_ai','check_code','todo_add','todo_done','todo_remove',
  'todo_list','describe_image','calculator','statistics','run_js','run_py','render_chart','wait',
  'web_search','web_fetch','kb_write','kb_read','kb_delete','kb_commit','kb_list','kb_search',
  'undo_last','undo_list','deliver','ask_user','remember'
].map(n => ({ type: 'function', function: { name: n } }));
`;

const tests = `
const feedAll = (filter, chunks) => {
  let text = '', calls = [];
  for (const c of chunks) {
    const r = filter.feed(c);
    text += r.text; calls = calls.concat(r.calls);
  }
  const f = filter.flush();
  text += f.text; calls = calls.concat(f.calls);
  return { text, calls };
};
const splitEvery = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };
const one = (r) => r.calls.length === 1 ? JSON.parse(r.calls[0].function.arguments) : null;

/* ---------- 1. 截图里那种 ask_user ---------- */
const SHOT = ['<ask_user>',
  '<question>试吃 Codespaces，你想先要哪一样? </question>',
  '<options>',
  '<option>一套 devcontainer.json 模板（Node + Python 通用，含端口转发），写进 VFS 方便直接抄</option>',
  '<option>算一下我这项目一天开几小时、免费额度够不够、怎么省钱</option>',
  '<option>横向对比 Codespaces / Gitpod / 本地 devcontainer CLI，帮我选</option>',
  '</options>',
  '</ask_user>'].join('\\n');

let r = feedAll(createXmlToolFilter(), [SHOT]);
__log(r.calls.length === 1 && r.calls[0].function.name === 'ask_user', 'ask_user：识别成 1 个工具调用');
let args = one(r);
__log(args && args.question === '试吃 Codespaces，你想先要哪一样?', 'ask_user：question 正确（并去掉尾部空格）');
__log(args && Array.isArray(args.options) && args.options.length === 3, 'ask_user：options 是长度 3 的数组');
__log(args && /^一套 devcontainer\\.json 模板/.test(args.options[0]), 'ask_user：options[0] 内容正确');
__log(r.text.trim() === '', 'ask_user：正文里不再残留原始标签');

/* ---------- 2. 逐字符流式喂入也要一致（关键：跨 chunk） ---------- */
r = feedAll(createXmlToolFilter(), splitEvery(SHOT, 1));
__log(r.calls.length === 1 && one(r).question === '试吃 Codespaces，你想先要哪一样?', '逐字符流式：仍解析出同一个调用');
__log(r.text.trim() === '', '逐字符流式：没有把半个标签漏进正文');

/* ---------- 3. 标签在正文中间（前面有说明文字） ---------- */
r = feedAll(createXmlToolFilter(), ['好的，先确认一下：\\n' + SHOT + '\\n选完我就开工。']);
__log(r.calls.length === 1 && /先确认一下/.test(r.text) && /选完我就开工/.test(r.text), '前后正文都保留，调用被抽出');

/* ---------- 4. 代码块里的例子不执行 ---------- */
const codeExample = '这是写法示例：\\n\\n\`\`\`\\n' + SHOT + '\\n\`\`\`\\n\\n照这个格式发就行。';
r = feedAll(createXmlToolFilter(), splitEvery(codeExample, 7));
__log(r.calls.length === 0, '代码块内：不当成调用');
__log(r.text.includes('<ask_user>') && r.text.includes('</ask_user>'), '代码块内：标签原样保留');

/* ---------- 5. 提到标签名但不是在调用（fail-open） ---------- */
r = feedAll(createXmlToolFilter(), ['我会用 <ask_user> 来问你。']);
__log(r.calls.length === 0 && r.text === '我会用 <ask_user> 来问你。', '正文提到 <ask_user>：原样透传、不吞字');
r = feedAll(createXmlToolFilter(), ['<read_file>这个标签是干嘛的</read_file>']);
__log(r.calls.length === 0 && r.text.includes('这个标签是干嘛的'), '标签内无子元素：不误判成调用');

/* ---------- 6. 写文件的参数与缩进 ---------- */
const writeXml = ['<write_file>',
  '  <path>/tmp/x.py</path>',
  '  <content>',
  '    def f():',
  '        return 1',
  '',
  '    print(f())',
  '  </content>',
  '</write_file>'].join('\\n');
r = feedAll(createXmlToolFilter(), [writeXml]);
args = one(r);
__log(r.calls.length === 1 && r.calls[0].function.name === 'write_file', 'write_file：识别成功');
__log(args && args.path === '/tmp/x.py', 'write_file：path 正确');
__log(args && args.content === 'def f():\\n    return 1\\n\\nprint(f())', 'write_file：content 去缩进但保留代码相对缩进');
__log(args && typeof args.content === 'string', 'write_file：content 仍然是字符串（没被 JSON.parse 破坏）');

/* ---------- 7. 标量参数转类型 ---------- */
r = feedAll(createXmlToolFilter(), ['<todo_done><id>2</id><done>false</done></todo_done>']);
args = one(r);
__log(args && args.id === 2 && args.done === false, 'todo_done：id 转数字、done 转布尔');

/* ---------- 8. 实体转义 ---------- */
r = feedAll(createXmlToolFilter(), ['<write_file><path>/a.md</path><content>a &amp;&amp; b &lt; c</content></write_file>']);
args = one(r);
__log(args && args.content === 'a && b < c', '实体转义还原：' + (args && args.content));

/* ---------- 9. Anthropic 风格 function_calls/invoke ---------- */
const anth = ['<function_calls>',
  '  <invoke name="read_file">',
  '    <parameter name="path">/notes/a.md</parameter>',
  '    <parameter name="start_line">3</parameter>',
  '  </invoke>',
  '</function_calls>'].join('\\n');
r = feedAll(createXmlToolFilter(), splitEvery(anth, 5));
args = one(r);
__log(r.calls.length === 1 && r.calls[0].function.name === 'read_file', 'invoke 风格：识别 read_file');
__log(args && args.path === '/notes/a.md' && args.start_line === 3, 'invoke 风格：参数与类型正确');

/* ---------- 10. Hermes 风格 <tool_call>{json}</tool_call> ---------- */
r = feedAll(createXmlToolFilter(), ['<tool_call>{"name":"todo_add","arguments":{"text":"买菜"}}</tool_call>']);
args = one(r);
__log(r.calls.length === 1 && r.calls[0].function.name === 'todo_add' && args.text === '买菜', 'tool_call JSON：识别成功');

/* ---------- 11. 多块 + 中间正文 ---------- */
r = feedAll(createXmlToolFilter(), [
  '先记一笔\\n',
  '<todo_add><text>写文档</text></todo_add>',
  '\\n再看看文件\\n',
  '<read_file><path>/README.md</path></read_file>'
]);
__log(r.calls.length === 2, '多块：两个调用都被识别');
__log(/先记一笔/.test(r.text) && /再看看文件/.test(r.text), '多块：中间正文保留');

/* ---------- 12. 未闭合（模型被截断）也要能用 ---------- */
r = feedAll(createXmlToolFilter(), ['<ask_user><question>还继续吗</question><options><option>继续</option><option>停</option></options>']);
args = one(r);
__log(r.calls.length === 1 && args.question === '还继续吗' && args.options.length === 2, '未闭合：flush 时仍能救回调用');

/* ---------- 13. 纯聊天模式（enabled=false）完全透传 ---------- */
r = feedAll(createXmlToolFilter({ enabled: () => false }), [SHOT]);
__log(r.calls.length === 0 && r.text === SHOT, '纯聊天模式：不做转换、不动正文');

/* ---------- 14. 未知标签不误伤 ---------- */
r = feedAll(createXmlToolFilter(), ['<foo><bar>1</bar></foo>']);
__log(r.calls.length === 0 && r.text.includes('<foo>'), '未知标签：原样输出');

/* ---------- 14b. 旧的 arg_key/arg_value 方言保持原样透传（交给 parseTextToolCalls 处理） ---------- */
const legacy = '<tool_call>read_file<arg_key>path</arg_key><arg_value>/a.md</arg_value></tool_call>';
r = feedAll(createXmlToolFilter(), [legacy]);
__log(r.calls.length === 0 && r.text === legacy, 'arg_key/arg_value 老方言：不吞不改，原样留给后置解析');

/* ---------- 15. ask_user 缺 options 时仍可用（渲染层会补默认按钮） ---------- */
r = feedAll(createXmlToolFilter(), ['<ask_user><question>确认删除？</question></ask_user>']);
args = one(r);
__log(r.calls.length === 1 && args.question === '确认删除？' && args.options === undefined, 'ask_user 无 options：照常产出调用');

console.log(__fail ? '\\n' + __fail + ' 项失败' : '\\n全部 XML 工具调用测试通过');
if (__fail) process.exit(1);
`;

const code = `(async () => {\n${prelude}\n${moduleCode}\n${tests}\n})().catch(e => { console.error('测试异常：' + (e && e.stack || e)); process.exit(2); });`;
const tmpUrl = new URL('./.tmp_xml_tool.mjs', import.meta.url);
fs.writeFileSync(tmpUrl, code, 'utf8');
try { await import(tmpUrl.href); } finally { try { fs.unlinkSync(tmpUrl); } catch (_) {} }
