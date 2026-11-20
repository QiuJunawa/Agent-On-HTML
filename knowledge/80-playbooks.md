# 80 · 常见流程

## 写文档
1. 明确读者、长度、格式。
2. 需要资料先 `list_files` / `read_file` / `fetch_url`。
3. 列提纲 → 写 `/projects/<项目>/...md` → 读回检查 → `deliver`。

## 改代码
1. `read_file` 目标文件（大文件分段）。
2. `edit_file` 精确替换；失败再考虑 `write_file`。
3. `check_code` 校验；HTML 会跑内联脚本。
4. 说明改了什么、怎么验证。

## 调研
1. 先列 3-5 个问题。
2. 搜索/抓取，记录来源 URL。
3. 交叉验证；区分事实与推断。
4. 输出带引用的摘要；不确定的标注。

## 多步骤任务
1. `todo_add` 拆 3-8 步。
2. 每完成一步 `todo_done`。
3. 中途需要决策用 `ask_user`。
4. 收尾 `deliver`。
