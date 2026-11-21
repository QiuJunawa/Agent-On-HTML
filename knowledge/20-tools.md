# 20 · 工具速查

默认只下发 5 个核心工具（4 个文件工具 + `execute_script`）与 `tools_expand`；需要其他分组时先展开，省 token。

## 文件系统 fs
`list_files` / `read_file` / `write_file` / `append_file` / `edit_file` / `delete_path` / `move_path` / `create_dir` / `search_files`
- 绝对路径，`/` 开头。
- 改局部优先 `edit_file`；整写前先 `read_file`。
- `write_file` 支持 `start_line/end_line` 行替换；`read_file` 支持行/列窗口与 `query`。
- 同一轮同一文件不要同时 `write_file` 和 `edit_file`，会被调度层拦截。
- 写/删/移动/覆盖会记入本轮撤销栈；删除/覆盖/移动前弹确认。

## 网络 net
`fetch_url`：抓 http/https 文本，HTML 提取正文；需确认；超长自动存 `/tmp`。

## 任务与交互 task
`todo_add/done/remove/list`、`ask_user`。
- 复杂任务先拆 3-8 步；`ask_user` 后本轮结束。
- 收尾交付不要额外调用工具：在正文单独一行写 `[deliver:标题 | 描述 | /文件1, /文件2]`，界面会渲染成交付卡。

## 计算与代码 compute
`calculator`、`statistics`、`run_js`（Worker，8 秒）、`execute_script`（CodeAct：Worker 里写脚本，`AgentAPI.call` 批量调工具）、`check_code`、`wait`（≤60 秒）。
- `run_js` 只做纯计算，不能调工具；批量读文件、改名、按目录处理用 `execute_script`。
- `execute_script` 的 `onError`：`abort` 默认终止、`continue` 返回 null 并记录、`retry` 重试 2 次；`maxSteps` 默认 100；危险操作仍逐个确认。
- 脚本 Worker 内没有网络、浏览器存储和嵌套 Worker；文件读写与工具调用都经 `AgentAPI` 回主线程，受白名单、步数和确认框约束。

## 可视化 media
`render_chart`：bar / line / pie / doughnut。

## 系统 system
`undo_last` / `undo_list`（最多 3 轮）、`task_status` / `task_cancel`、`remember`。

## Git 仓库 git（用户配置后）
`git_list` / `git_read`（只读）、`git_write` / `git_delete` / `git_commit_batch`（真实 commit，需确认）。
- 缺省 platform/repo/token/branch 读「设置 → Git 仓库」。
- GitHub/GitLab 批量提交为一次 commit；Gitee 顺序提交。

## 插件与官方插件库 plugin
`plugin_list` / `plugin_create` / `plugin_update` / `plugin_delete` / `plugin_toggle` / `plugin_lib_list` / `plugin_lib_install`。
- 插件代码写 `/plugins/<id>.js` + `.json`，默认禁用；启用需用户确认。
- 插件用 `AgentAPI.defineTool(name, spec, handler)` 注册，下一轮可调用；也可用 `AgentAPI.registerHook(event, fn)` 注册生命周期钩子（`beforeRequest / afterUserMessage / afterToolResult / afterAssistantMessage`），详见 `plugin-dev-v2.md` 第 4.5 节。
- 官方库：`https://qiujunawa.github.io/AOH_Plugins/index.json`。先 `plugin_lib_list` 看清单，再 `plugin_lib_install(id)`；安装前会展示来源/代码摘录，默认不启用。
- 插件库是第三方代码，能力与描述不能代替安全判断。

## 调度行为
- 只读工具并行（最多 4），写操作串行。
- 工具超时转后台，用 `task_status` 查。
- 预算：轮数 / 调用数 / 墙钟 / 成本，任一超限停止。
- 工具结果超 30k 字符裁剪；相同大结果用占位符。
