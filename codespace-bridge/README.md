# Codespace Bridge · 让浏览器里的 Agent 在你的 Codespace 里干活

Agent-On-HTML 本身是纯前端页面（IndexedDB 虚拟文件系统），执行不了真实命令。
这个桥接服务跑在 **你的 GitHub Codespace** 里，只做三件事：执行命令、读写文件、起服务；
页面通过 GitHub 的端口转发地址（`https://<codespace 名>-<端口>.app.github.dev`）调用它。

```
浏览器页面 (index.html)
   │  HTTPS + Bearer token（GitHub 端口转发，端口需 Public）
   ▼
Codespace: codespace-bridge/server.mjs  ──►  shell / 文件系统 / python http.server
```

---

## 一、最快路径（3 步）

1. **开 Codespace**：在 GitHub 仓库页 `Code → Codespaces → Create codespace on main`。
   本仓库自带 `.devcontainer/`，创建后桥接会**自动启动**，端口 8787 会自动转发
   （首次需要在「端口 / Ports」面板把 8787 设为**公开**，或者用页面设置里的「端口设为公开」按钮）。

2. **拿令牌**：打开 Codespace 的终端，看启动日志里的 `令牌 xxxxx`（也保存在 `~/.agent-bridge.token`）：

   ```bash
   cat ~/.agent-bridge.token
   ```

   如果没看到日志，手动跑一次：

   ```bash
   node codespace-bridge/server.mjs
   ```

3. **填进页面**：打开 https://qiujunawa.github.io/Agent-On-HTML/ → `⚙ 设置 → Codespace`
   - **GitHub Token**：classic PAT，勾选 `codespace` 权限（用于列/启动 Codespace、把端口设为公开）
   - 点 **刷新列表** → 选中你的 Codespace
   - **桥接令牌**：粘贴第 2 步的令牌
   - 点 **检测连接** → 看到 `✅ 桥接正常` 就通了

> 这个流程同样适用于**别的仓库**：把 `codespace-bridge/` 和 `.devcontainer/` 两个目录拷进去，
> 或者直接在任意 Codespace 终端里跑下面的一行命令（不需要动仓库）。

## 二、一行命令安装（不动仓库）

```bash
curl -fsSL https://raw.githubusercontent.com/QiuJunawa/Agent-On-HTML/main/codespace-bridge/server.mjs -o ~/agent-bridge.mjs && node ~/agent-bridge.mjs
```

启动后会打印：

```
│ 公开地址   https://<你的 codespace>-8787.app.github.dev
│ 令牌       <随机 48 位十六进制，也写入 ~/.agent-bridge.token>
```

第一次需要把该端口设为公开：Codespace 底部 **端口 / Ports** 面板 → 找到 8787 → 右键
`端口可见性 → 公开`。之后页面设置里点「端口设为公开」也可以（需要 GitHub Token）。

不想让它常驻：`pkill -f agent-bridge.mjs`；停掉 Codespace 也会让它失效。

## 三、接口约定（想自己接也看这里）

所有接口 `POST`（`/health` 为 `GET`），请求体 JSON，响应 JSON，必须带
`Authorization: Bearer <token>`（也支持 `?token=` 查询参数，给不方便带头的转发链路兜底）。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `GET /health` | — | `{ ok, host, user, platform, node, root, cwd, codespace, uptime_s }` |
| `POST /exec` | `{ cmd, cwd?, timeout_ms? }` | `{ code, stdout, stderr, cwd, duration_ms, timed_out, truncated }` |
| `POST /ls` | `{ path?, all? }` | `{ path, entries:[{name,type,size,mtime}] }` |
| `POST /read` | `{ path, start_line?, end_line?, max_bytes? }` | `{ path, size, content, binary, truncated, total_lines }` |
| `POST /write` | `{ path, content, append?, mkdir? }` | `{ path, bytes }` |
| `POST /append` | 同 `/write` + `append:true` | 同上 |

错误统一返回 `{ ok:false, error:"..." }` 且 HTTP 500（鉴权失败为 401）。
所有响应都带 `Access-Control-Allow-Origin: *`，并处理 `OPTIONS` 预检。

## 四、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CS_BRIDGE_PORT` | `8787` | 监听端口 |
| `CS_BRIDGE_TOKEN` | 自动生成 | 访问令牌；不填则生成并写入 `~/.agent-bridge.token` |
| `CS_BRIDGE_TOKEN_FILE` | `~/.agent-bridge.token` | 令牌文件位置 |
| `CS_BRIDGE_ROOT` | 当前目录 | 文件读写根目录（默认就是仓库根） |
| `CS_BRIDGE_MAX_OUT` | `120000` | 单次命令输出上限（字节） |
| `CS_BRIDGE_ALLOW_ESCAPE` | 关 | 设 `1` 允许文件操作越出根目录 |
| `CS_BRIDGE_DISABLE_EXEC` | 关 | 设 `1` 只保留文件读写，禁用 `/exec` |

例：`CS_BRIDGE_ROOT=/workspaces/demo CS_BRIDGE_PORT=9000 node codespace-bridge/server.mjs`

## 五、安全

- **端口设为 Public = 谁拿到地址谁就能访问**。唯一的门禁是令牌：令牌泄露等于命令执行权泄露。
  不用时停掉 Codespace，或在页面设置里清空桥接令牌。
- 令牌只存在**页面本地**（可选主密码 AES-256 加密），不进对话记录（`/conversations/` 会做密钥脱敏）。
- 默认 `cs_exec` 每次执行都会在页面上弹窗确认；关掉这个开关前想清楚。
- 桥接以 **Codespace 用户身份**运行，命令没有任何沙箱限制；别把别人给的、来路不明的命令交给它跑。
- 页面是 `https://qiujunawa.github.io`，访问 `*.app.github.dev` 属于跨站请求，桥接已经处理了 CORS；
  如果你把页面部署到别处，同样可用（CORS 对任意来源开放）。

## 六、排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `连不上 Codespace 桥接` | Codespace 没启动 / 桥接脚本没跑 / 端口不是 Public / 端口号填错 |
| 页面提示「端口返回的是网页而不是桥接响应」 | 端口是 Private，GitHub 返回了登录页 → 设为 Public |
| `桥接鉴权失败（401）` | 令牌不一致：重启脚本后换新令牌，或检查设置里是否粘全 |
| 命令 `code: 127`（command not found） | 用绝对路径，或先 `source ~/.bashrc`；桥接用的是非交互 shell |
| 输出截断 | 调大 `CS_BRIDGE_MAX_OUT`；页面侧单次最多返回 3 万字符 |
| 首次访问 `app.github.dev` 报 502/404 | 端口刚转发，等 5~15 秒再试；确认服务监听在 `0.0.0.0` 而不是 `127.0.0.1` |

## 七、自测

```bash
# 终端 A
CS_BRIDGE_PORT=8799 CS_BRIDGE_TOKEN=testtoken123 node codespace-bridge/server.mjs
# 终端 B（24 个用例）
node codespace-bridge/tests/bridge.test.mjs
```
