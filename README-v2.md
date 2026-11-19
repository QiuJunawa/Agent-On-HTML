# 小匣 2.0 · 浏览器内 AI Agent

纯前端、无后端、无第三方依赖的单页 Agent。文件系统、对话、记忆、待办全部保存在本机 IndexedDB。

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
index-v2.html     页面骨架（导航 / 侧栏 / 聊天 / 编辑器 / 任务页 / 设置弹窗）
app.css           全部样式（深/浅主题、响应式、动效可被 reduced-motion 关闭）
js/util.js        路径、格式化、token 估算、文件读写、剪贴板等纯函数
js/store.js       IndexedDB 封装 + VFS（元数据常驻内存、正文 LRU、内存降级）
js/markdown.js    安全 Markdown 渲染（先转义、标签白名单、链接协议限制）
js/ui.js          SVG 图标、Toast、确认框、右键菜单、弹窗
js/tools.js       26 个工具定义 / 分组懒加载 / 执行器 / 撤销 / 待办 / 记忆
js/agent.js       配置、SSE 流式解析、消息清洗与裁剪、预算、工具调度、Agent 循环
js/chat.js        会话存储、消息渲染、流式 UI、工具卡片、图表/交付/提问卡片、输入区
js/settings.js    设置面板、服务商预设、连接测试、导入导出、数据清理
js/app.js         启动、文件树、编辑器、待办、任务页、导航、快捷键
```

加载顺序即依赖顺序，全部经典 `<script>`，不用 ES Module——`file://` 与 GitHub Pages 都能直接跑。

## 相对原版的关键改动

### 性能

| 原版 | 现在 |
| --- | --- |
| 流式每个 delta 都 `innerHTML = mdToHtml(全文)` 重建 | 流式只写 `textContent`，80ms 节流；结束才解析一次 Markdown |
| 每次保存把所有会话全量序列化进 localStorage | 每会话独立 `kv` 键 + 元数据索引；只写当前会话 |
| 57 个工具定义每轮全量下发 | 默认 4 个核心文件工具 + `tools_expand`，按分组展开 |
| 消息区每次重绘整段会话 | 只渲染最近 60 条，可向上加载；工具卡片按调用增量更新 |
| KaTeX / JSZip / Pyodide / 外部字体等 CDN 依赖 | 全部移除，零外部请求 |
| 会话正文与 VFS 内容双份常驻内存 | VFS 元数据常驻、正文 LRU（80 项 / 4MB） |

### 成本（token）

- **静态 system + 运行时上下文追加到最后一条 user**：system 永不变，前缀缓存命中率更高。
- **自动模式**：短问候、纯问答不带工具定义；命中文件/代码/任务等意图才进 Agent。
- **懒加载工具**：首轮工具定义从约 57 个降到 5 个。
- **工具结果 30k 字符裁剪 + 大结果去重**：相同大结果第二次只回占位符。
- **上下文按 token 预算裁剪**，并在末尾说明省略了多少条；超限时临时收紧预算重试一次，不写回设置。
- **思考内容不回传**：assistant 只带空的 `reasoning_content`，避免每轮重复计费。
- **标题生成可关闭**（默认开启一次小请求）。

### 稳定性

- 同一轮同一文件 `write_file` / `edit_file` 混用直接拦截，不会互相覆盖。
- 只读工具并行（并发 4），写操作串行；工具超时转后台任务，可用 `task_status` 查询。
- 停止生成时保留已生成的正文，并补齐未执行的 tool 响应，下一轮不会 400。
- 任何异常结束都会修复 dangling tool_calls；消息清洗按 `tool_call_id` 严格配对。
- 预算硬控：轮数 / 工具次数 / 墙钟 / 成本，超限前先补齐 tool 响应再退出。
- 删除、覆盖、移动、联网抓取走统一确认框，可按会话记住。
- IndexedDB 打不开时 3.5 秒降级内存模式，并在状态栏明确提示“关页面即丢”。

## 功能保留 / 移除

保留：VFS 与文件树、编辑器（Markdown / HTML / 图片）、流式对话、思考块、工具卡片、图表、交付卡、提问卡、待办、长期记忆、撤销（最近 3 轮）、任务页、会话存档 Markdown、备份导入导出、深/浅主题。

移除及原因：

| 移除 | 原因 |
| --- | --- |
| Codespaces 桥接与 `cs_*` 工具 | 依赖外部隧道与令牌，绝大多数本地使用用不到，且是主要故障源 |
| 插件系统 / 插件库 / 定时任务页 | 使用率低、状态面大；保留核心 Agent 链更可靠 |
| Gitee / WebDAV / Gist / 恢复码云同步 | 涉及第三方凭据与跨域，改为本地 JSON 备份 |
| Pyodide `run_py` | 体积与首屏成本过高；`run_js` 已覆盖脚本计算 |
| 外部知识库 `kb_*`、`web_search`、`download_url` | 与 `fetch_url` / VFS 重叠，减少工具数量 |
| 浮窗主题 / 六面天空盒 / 字体方案 | 纯装饰，拖慢首屏 |
| KaTeX、JSZip | 去掉 CDN；公式以代码块呈现，压缩/解压走系统工具 |

如确实需要上述能力，可在现有工具层按分组增量加回，不影响主链。

## Agent 链路

1. 用户消息 + 附件 → 写入会话（图片存 VFS，按模型能力决定是否走 `image_url`）。
2. `system` 固定；运行时上下文（时间、模型、存档路径、记忆命中、懒加载提示、附件列表）拼到最后一条 user。
3. `POST {baseUrl}/chat/completions`，SSE 解析 `delta.content` / `reasoning_content` / `tool_calls[index]` / `usage`。
4. 有工具调用 → 入栈 assistant(tool_calls) → 调度执行 → 每个结果以 `role:tool` 回灌 → 下一轮。
5. 无工具调用 → 结束；写入存档、更新 token/成本条、可选生成标题。
6. 预算超限 / 用户停止 / 异常 → 补齐 tool 响应后退出，界面保留已有内容。

## 验收状态

已用本地 mock OpenAI SSE 服务跑过：

- 多轮工具链：`read_file` → `tools_expand` → `render_chart` → 最终 Markdown；3 张工具卡完成、图表绘制正常；
- 停止生成：保留已生成正文、显示“已停止生成”、无 dangling tool call；
- 提问卡、交付卡（点击跳转编辑器）、任务页、待办、主题切换、设置持久化、会话删除、刷新后会话与存档仍在；
- 缺 Key 自动打开设置；控制台无报错。

后续又做了若干边界修复（跨会话保存、图表随主题重绘、任务页名称、副本命名、确认框并发等），**尚未再跑全量回归**——这部分留给你验收。

真实服务商兼容性（CORS、输出上限、`thinking` 参数）需用你的 Key 在目标服务商上验证；当前默认不发送 `max_tokens`，兼容性优先。

## 安全

- Key 仅存本机；页面无任何外发请求，除你自己配置的模型端点。
- Markdown 渲染先转义再加白名单标签；链接只允许 `http/https/mailto/#//`，图片只允许 `http/https/data:image`。
- HTML 预览使用 `sandbox="allow-scripts"`（不含 same-origin），不能读本页数据。
- 导入备份会覆盖当前数据，导入前有确认；导出文件包含 Key，注意保管。

## 交付说明

- 本版是**多文件结构**（`index-v2.html` + `js/*.js` + `app.css`），已推送到 `QiuJunawa/Agent-On-HTML` 的 `main`；旧 `index.html` 保持原样，方便对照与回滚。
- 线上地址：<https://qiujunawa.github.io/Agent-On-HTML/index-v2.html>。
- 没有使用你的真实 API Key；上面的验收全部走本地 mock。需要我做真实服务商兼容性实测时，把 Key 发我，测完立即销毁。
