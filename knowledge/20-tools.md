# 20 · 工具速查

默认只下发 4 个核心文件工具 + `tools_expand`；需要其他分组时先展开，省 token。

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
`todo_add/done/remove/list`、`ask_user`、`deliver`。
- 复杂任务先拆 3-8 步；`ask_user` 后本轮结束；`deliver` 只在收尾。

## 计算与代码 compute
`calculator`、`statistics`、`run_js`（Worker，8 秒）、`check_code`、`wait`（≤60 秒）。

## 可视化 media
`render_chart`：bar / line / pie / doughnut。

## 系统 system
`undo_last` / `undo_list`（最多 3 轮）、`task_status` / `task_cancel`、`remember`。

## Git 仓库 git（用户配置后）
`git_list` / `git_read`（只读）、`git_write` / `git_delete` / `git_commit_batch`（真实 commit，需确认）。
- 缺省 platform/repo/token/branch 读「设置 → Git 仓库」。
- GitHub/GitLab 批量提交为一次 commit；Gitee 顺序提交。

## 插件 plugin
`plugin_list` / `plugin_create` / `plugin_update` / `plugin_delete` / `plugin_toggle`。
- 插件代码写 `/plugins/<id>.js` + `.json`，默认禁用；启用需用户确认。
- 插件用 `AgentAPI.defineTool(name, spec, handler)` 注册，下一轮可调用。

## 调度行为
- 只读工具并行（最多 4），写操作串行。
- 工具超时转后台，用 `task_status` 查。
- 预算：轮数 / 调用数 / 墙钟 / 成本，任一超限停止。
- 工具结果超 30k 字符裁剪；相同大结果用占位符。
