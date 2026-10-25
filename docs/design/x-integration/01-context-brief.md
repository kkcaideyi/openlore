# X 接入上下文

- 日期：2026-10-24；仓库源码基线 `926347d`，当前 HEAD `f637c70`，分支 `ykzhu14/access_x`。
- 目标：在个人 Fork 验证 X→RSS 接入，复用 OpenLore 生产链路，形成可向上游提交的改动。
- 用户已明确要求本轮评估并给出方案；进入方案阶段，尚未授权实现、部署或外部交付。
- 历史需求见 [需求记录](01-requirements-and-status.md)，总体架构见 [项目分析](../openlore-understanding/01-context-brief.md)。

## 已核实事实

| 事实 | 证据（路径相对仓库根） |
| --- | --- |
| 已有 RSS 适配与 Python Feed 解析 | `apps/server/src/modules/collection/collectors/web_feed/adapter.ts`；`workers/python/src/openlore_collectors/web_feed/parser.py` |
| Python 把 description/summary 标记为摘要，content 长度超过 200 才标为 full | `parser.py` 的正文选择分支 |
| RSS 日期标记为 verified:false，来源默认开启日期回源核验 | Feed 适配器；`packages/contracts/src/entities.ts` |
| 准入至少要求 80 字符；初审另会拒绝仅含标题的正文 | `collection/quality.ts`；`infrastructure/content/review-body.ts` |
| 同 source/item 已 ready 时立即跳过，原始 X URL 别名不会自动合并 | `collection/service.ts:enqueue`；`quality.ts:normalizeUrl` |
| 本机和部分内网地址被 HTTP 客户端拒绝 | `infrastructure/http/client.ts` |
| Python 查找 `.venv/bin/python`，没有显式查找 Windows `.venv/Scripts/python.exe` | `infrastructure/python/runner.ts` |
| 当前初审证据引文最少 16 字符 | `packages/contracts/src/article-review.ts` |

## RSSHub 新证据

2026-10-24 读取在线 master 文件，未固定 commit，以下是源码观察而非可用性实测：

- [用户时间线路由](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/user.ts)：`/twitter/user/:id/:routeParams?`，支持回复、转帖过滤。
- [说明](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/namespace.ts)：推荐 `TWITTER_AUTH_TOKEN`；可选开发者 API key/secret；旧用户名密码移动端路径已标为不可用。
- [API 选择](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/api/index.ts)：Web token/第三方接口配置优先，否则走开发者 API；未配置则抛错。
- [输出转换](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/utils.ts)：处理 full_text、媒体和引用，生成标题/描述等条目内容。

## 认识与约束

RSSHub 是首选验证对象；需要账号会话或接口权限，不能承诺匿名公共实例即可使用。抓到 RSS、进入内容池、完成研究是三个分别验收的步骤。

不新建工作树，不修改远程地址。模型调用、测试 Git 仓库与测试群的真实交付在实施时单独确认目标。现有数据保持默认文章策略；不能全局关闭 HTTP 私网保护或正文准入。

## 待确定但不阻塞设计

需要用户在真实验证前提供：2～3 个账号名、RSSHub 可运行的位置、可用 X 会话或 API 的选择；凭据在本机配置，不写入文档。

设计默认：先保存独立帖子及其中链接，不自动抓取外链、不合并完整线程、不做视频/OCR；这些范围可按反馈调整。可靠性、费用和持续更新能力仍待真实验证。
