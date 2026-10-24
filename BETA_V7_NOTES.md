# Beta v7 改动说明

此分支由 AI 助手推送，包含 beta 优化阶段的全部改动：

1. **上下文管理**（对齐 DeepSeek-Harness）：ToolResult 头尾修剪、上下文溢出自动恢复、预算计入 reasoning_content、存档脱敏
2. **script 截断 bug 修复**：checkHtml 替换字符串不再含裸 `</script>`，此前约 6000 行 JS 在浏览器中不执行
3. **[ref:] 占位符守卫**：自引用拒绝、同轮并发写拒绝（脏快照防护）
4. **read_file/searchInFile 超长单行截断**：单行 >4000 字符只保留匹配窗口，总输出预算 30000
5. **edit_file 相似行提示截断**
6. **20-tools.md 文档对齐**：37 个工具补齐（edit_file/undo_last/undo_list/remember）、search_files 参数、[ref:] 纪律
7. **行列级替换**：read_file/write_file/append_file/kb_read/kb_write 支持 start_col/end_col（1-based 含两端）；本地 write_file 补上此前缺失的行级替换实现

请在 GitHub 上 review 后合并。