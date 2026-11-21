# 小匣 2.0 · 浏览器内 AI Agent

纯前端、无后端的单页 Agent。文件系统、对话、记忆、待办全部保存在本机 IndexedDB。KaTeX 公式本地自托管；字体样式在首屏加载完成后异步注入。

## 访问地址

- 线上地址：<https://qiujunawa.github.io/Agent-On-HTML/index-v2.html>。
- 想改变点什么？去<https://github.com/QiuJunawa/AOH_Plugins>
- 发现问题？[我要提交bug](https://github.com/QiuJunawa/Agent-On-HTML/issues)

## 运行

```bash
# 任选其一
python3 -m http.server 8080     # 然后打开 http://localhost:8080/index-v2.html
# 或直接双击 index-v2.html（Chrome / Edge 下 file:// 也可用；部分浏览器会限制 file:// 的 IndexedDB）
```

首次打开 → 左下角设置 → 填 **API Base URL / API Key / 模型名** → 测试连接 → 开始对话。

- Base URL 填到 `/v1` 一级，例如 `https://api.deepseek.com`、`https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4`。
- Key 只存在本机 `localStorage`，不会上传到任何服务器；但导出备份会包含它，备份文件不要公开。

## 文件结构

```
index.html        页面骨架（导航 / 侧栏 / 聊天 / 编辑器 / 任务页 / 插件页 / 设置弹窗）
                  仓库里命名为 index-v2.html，旧 index.html 保持原样
app.css           全部样式（深/浅主题、响应式、动效可被 reduced-motion 关闭）
js/util.js        路径、格式化、token 估算、文件读写、剪贴板等纯函数
js/store.js       IndexedDB 封装 + VFS（元数据常驻内存、正文 LRU、内存降级、知识库播种）
js/markdown.js    安全 Markdown 渲染（先转义、标签白名单、链接协议限制、KaTeX 公式）
js/zip.js         无依赖 ZIP 打包与解压（右键文件夹下载 / 上传 .zip 自动解压进 VFS）
js/ui.js          SVG 图标、Toast、确认框、右键菜单、弹窗
js/knowledge.js   内置知识库（11 篇，首次启动写入 /knowledge）
js/git.js         GitHub / Gitee / GitLab 读写与批量提交
js/plugins.js     本地插件管理器 + 插件页 + 官方插件库（AOH_Plugins）
js/tools.js       工具定义 / 分组懒加载 / 执行器 / 撤销 / 待办 / 记忆 / Git / 插件管理
js/agent.js       配置、SSE 流式解析、消息清洗与裁剪、预算、工具调度、Agent 循环
js/chat.js        会话存储、消息渲染、流式 UI、工具卡片、图表/交付/提问卡片、输入区
js/settings.js    设置面板、服务商预设、连接测试、导入导出、数据清理
js/app.js         启动、文件树（80ms 合并刷新 + 自动展开）、编辑器、待办、任务页、导航、快捷键
knowledge/        知识库源文件（构建 js/knowledge.js 用）
vendor/katex/     自托管 KaTeX（js + css + 20 个 woff2 字体）
```

加载顺序即依赖顺序，全部经典 `<script>`，不用 ES Module——`file://` 与 GitHub Pages 都能直接跑。

## 相对原版的关键改动

### 性能

| 原版 | 现在 |
| --- | --- |
| 流式每个 delta 都 `innerHTML = mdToHtml(全文)` 重建 | 流式即渲染 Markdown，自适应间隔节流（60ms 起，长文放宽到 260ms）；仅内容变化才重解析 |
| 每次保存把所有会话全量序列化进 localStorage | 每会话独立 `kv` 键 + 元数据索引；只写当前会话 |
| 57 个工具定义每轮全量下发 | 默认 5 个核心工具（4 个文件工具 + `execute_script`）+ `tools_expand`（首轮共 6 个），按分组展开 |
| 消息区每次重绘整段会话 | 按「最近 60 条 / 18 万字符」双重预算渲染，发送时同步裁掉预算外旧 DOM，可向上加载；离屏消息 `content-visibility` 跳过布局，工具卡片按调用增量更新 |
| 保存时同步重写整份 Markdown 存档 | 会话 Markdown 存档延后 3 秒批量写，切会话/流式结束不再同步扫描全文；工具结果用 Map 单次索引 |
| Token 统计每次全量扫描所有正文 | 每条消息的 token 估算按对象缓存，正文变化才重算 |
| KaTeX / JSZip / Pyodide 等 CDN 依赖 | KaTeX 本地自托管；字体 CDN 改为 load 后异步注入，不阻塞首屏 |
| 会话正文与 VFS 内容双份常驻内存 | VFS 元数据常驻、正文 LRU（80 项 / 4MB） |

### 成本（token）

- **静态 system + 运行时上下文追加到最后一条 user**：system 永不变，前缀缓存命中率更高。
- **自动模式**：短问候、纯问答不带工具定义；命中文件/代码/任务等意图才进 Agent。
- **懒加载工具**：首轮工具定义从约 57 个降到 6 个。
- **工具结果 30k 字符裁剪 + 大结果去重**：相同大结果第二次只回占位符。
- **上下文按 token 预算裁剪**，并在末尾说明省略了多少条；超限时临时收紧预算重试一次，不写回设置。
- **思考内容不回传**：assistant 只带空的 `reasoning_content`，避免每轮重复计费。
- **标题生成可关闭**（默认开启一次小请求）。

### 稳定性

- 同一轮同一文件 `write_file` / `edit_file` 混用直接拦截，不会互相覆盖。
- 只读工具并行（并发 4），写操作串行；工具超时转后台任务，`task_status` 最多持续监测 20 秒直到完成，`task_cancel` 可停止；设置页超时下限 10 秒。
- 停止生成时保留已生成的正文，并补齐未执行的 tool 响应，下一轮不会 400。
- 任何异常结束都会修复 dangling tool_calls；消息清洗按 `tool_call_id` 严格配对。
- 预算硬控：轮数 / 工具次数 / 墙钟 / 成本，超限前先补齐 tool 响应再退出。
- 删除、覆盖、移动、联网抓取走统一确认框，可按会话记住。
- IndexedDB 打不开时 3.5 秒降级内存模式，并在状态栏明确提示“关页面即丢”。

## 功能保留 / 移除

保留：VFS 与文件树（文件夹右键下载 .zip、上传 .zip 自动解压）、编辑器（Markdown / HTML / 图片）、流式对话、逐轮独立气泡、思考块、工具卡片、图表、交付卡（正文 `[deliver:...]` 标记，少一轮工具调用）、提问卡、待办、长期记忆、撤销（最近 3 轮）、任务页、会话存档 Markdown、备份导入导出、深/浅主题、KaTeX 行内/块级公式、界面/正文字体自定义、系统提示词自动保存与「恢复默认提示词」按钮、本地插件系统、官方插件库（AOH_Plugins）、Git 仓库工具、内置知识库。

移除及原因：

| 移除 | 原因 |
| --- | --- |
| Codespaces 桥接与 `cs_*` 工具 | 依赖外部隧道与令牌，绝大多数本地使用用不到，且是主要故障源 |
| 远端插件库 / 定时任务页 | 远端库涉及额外网络与信任面；本地插件管理已恢复，定时任务未恢复 |
| Gitee / WebDAV / Gist / 恢复码云同步 | 涉及第三方凭据与跨域，改为本地 JSON 备份 |
| Pyodide `run_py` | 体积与首屏成本过高；`run_js` 已覆盖脚本计算 |
| 外部知识库 `kb_*`、`web_search`、`download_url` | 与 `fetch_url` / VFS 重叠，减少工具数量 |
| 浮窗主题 / 六面天空盒 | 纯装饰，拖慢首屏 |
| JSZip 第三方库 | 自带最小 ZIP 读写实现（store / deflate-raw），不为压缩能力增加首屏体积 |

如确实需要上述能力，可在现有工具层按分组增量加回，不影响主链。

## Agent 链路

1. 用户消息 + 附件 → 写入会话（图片存 VFS，按模型能力决定是否走 `image_url`）。
2. `system` 固定；运行时上下文（时间、模型、存档路径、记忆命中、懒加载提示、附件列表）拼到最后一条 user。
3. `POST {baseUrl}/chat/completions`，SSE 解析 `delta.content` / `reasoning_content` / `tool_calls[index]` / `usage`。
4. 有工具调用 → 入栈 assistant(tool_calls) → 调度执行 → 每个结果以 `role:tool` 回灌 → 下一轮。
5. 无工具调用 → 结束；写入存档、更新 token/成本条、可选生成标题。
6. 预算超限 / 用户停止 / 异常 → 补齐 tool 响应后退出，界面保留已有内容。

## 验收状态

已用本地 mock OpenAI SSE 服务与 Chromium 冒烟验证：

- 多轮工具链：`read_file` → 最终正文；每轮独立 assistant 气泡（本次实测 2 轮 = 2 个气泡、1 张工具卡），第一轮无正文时状态占位会被清除；
- KaTeX：行内 `$x^2$` 与块级 `$$...$$` 均渲染出 `.katex`（2 个节点）；
- 知识库：首次启动 `/knowledge` 有 11 个文件，`/README.md` 种子文件在首屏即可读；设置 → 数据可「恢复默认知识库」；
- 插件：创建 → 启用 → 注册工具进入 `buildSpecs` → 禁用后注销，插件页正常渲染/返回对话；
- 官方插件库：拉取 `AOH_Plugins/index.json` 4 个条目，安装 `hello` 并启用，`hello_greet` 成功返回问候；页面显示「共 4 个 · 已安装 1」；
- 交付标记：最终正文 `[deliver:测试交付 | 一个文件 | /README.md]` 渲染成 1 张交付卡，正文不显示标记；
- 文件夹 ZIP：右键 `/projects` 出现「下载文件夹 (.zip)」，下载 `projects.zip`，`unzip -l` 校验 3 个条目（含子目录）；
- 上传 ZIP：聊天附件与侧栏上传选入真实 deflate 压缩包后自动解压到 `/uploads/<包名>/`，保留目录结构与中文文件名，附件条显示「3 个文件」；同名目录自动落为 `-2`；
- 系统提示词：设置 → Agent 输入后自动保存；「恢复默认提示词」可恢复内置默认；
- 长对话性能：300 条 / 4.5MB 合成会话，切换会话约 80–90ms（优化前约 750ms），DOM 只保留约 14–30 条；Token 统计首次约 20ms、后续 10 次合计不足 1ms；
- 长对话滚动：离屏消息使用 `content-visibility` 后仍能正确回到最后一条，向上滚到首条正常显示；
- VFS 刷新：写入 `/projects/new/test.md` 后 350ms 内文件树出现该文件，父目录自动展开；
- 字体：正文字体、界面字体变量均已应用；外部字体在 load 后注入，页面 load 约 230ms；
- 控制台无报错。

后续又做了若干边界修复（跨会话保存、图表随主题重绘、任务页名称、副本命名、确认框并发等），**尚未再跑全量回归**——这部分留给你验收。

真实服务商兼容性（CORS、输出上限、`thinking` 参数）需用你的 Key 在目标服务商上验证；当前默认不发送 `max_tokens`，兼容性优先。

## 安全

- Key 仅存本机；页面无任何外发请求，除你自己配置的模型端点。
- Markdown 渲染先转义再加白名单标签；链接只允许 `http/https/mailto/#//`，图片只允许 `http/https/data:image`。
- HTML 预览使用 `sandbox="allow-scripts"`（不含 same-origin），不能读本页数据。
- 导入备份会覆盖当前数据，导入前有确认；导出文件包含 Key，注意保管。
