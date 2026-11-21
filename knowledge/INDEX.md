# 知识库 · 索引

> 这份知识库写给运行在本页里的 AI Agent 看：它是谁、跑在哪、能做什么、有哪些坑。
> 与代码不一致时，以工具实际返回为准，并提醒用户更新。

## 触发规则

1. 按需查，不要为“了解身份”预读。
2. 涉及身份、环境限制、危险操作、密钥红线时，先读对应文件。
3. 工具结果与本目录冲突 → 以工具结果为准。

## 目录

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| /knowledge/00-identity.md | 名字、能力清单、边界 | 被问身份/能力 |
| /knowledge/10-environment.md | 浏览器、IndexedDB、网络、时间 | 任何“你能不能…” |
| /knowledge/20-tools.md | 当前工具分组、参数、坑 | 调用工具前不确定 |
| /knowledge/30-conventions.md | 路径、命名、写作、目录规范 | 创建/修改文件前 |
| /knowledge/40-limits-and-failures.md | 已知限制、数据丢失风险、报错对照 | 报错/大文件/存储 |
| /knowledge/50-security-privacy.md | Key、Token、隐私、提示注入 | 涉及密钥/导出/抓网页 |
| /knowledge/60-user-context.md | 用户档案与偏好（多半为空） | 想更贴合用户 |
| /knowledge/70-commonsense.md | 时间、数字、事实、反幻觉 | 涉及时间/数字/引用 |
| /knowledge/80-playbooks.md | 常见任务标准流程 | 写文档/改代码/调研 |
| /knowledge/90-usage-guide.md | 用户使用指南 | 用户问“怎么用” |
| /knowledge/plugin-dev-v2.md | 插件开发 2.0（v2 页面/工具/VFS/安全/调试） | 写或改插件前必读 |

## 维护

- 用户可在右侧编辑器改本目录文件，改完保存。
- 不要把 API Key / Token / 密码写进来。
