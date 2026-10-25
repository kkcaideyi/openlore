# X 接入：当前需求与进展

完整汇总与最新路线判断见 [Agent 交接文档](AGENT-HANDOFF.md)，涵盖 RSSHub 与开源 Python 直连评估。

更新日期：2026-10-24（Asia/Shanghai）。

## 目标与协作方式

为 OpenLore 增加 X 技术信息来源，优先尝试“X → 第三方 RSS 中间服务 → OpenLore 现有 RSS 采集链路”，同时比较开源直接采集方案。

在个人 Fork 开发、本地测试，通过后向 `decent-yu/openlore` 提交 PR。当前未进入实现阶段，尚未确定具体中间服务或采集库。

| 项目 | 当前配置 |
| --- | --- |
| 个人 Fork / origin | `git@github.com:kkcaideyi/openlore.git` |
| 原仓库 / upstream | `git@github.com:decent-yu/openlore.git` |
| 工作目录 | `D:\Project\openlore`，沿用现有检出目录，不另建工作树 |
| 分支 | `ykzhu14/access_x`（2026-10-24 实际检出；沿用当前名称） |
| 创建基线 | Fork 的 `origin/main`，`926347d5f17943847d639b75c8f9349780efcd6e` |
| 开发方式 | 在现有目录切换需求分支，`main` 分支保留 |

项目总体分析见 [OpenLore 项目理解与源码分析](../openlore-understanding/01-context-brief.md)。两份文档均保存在本需求分支。

## 已确认的现状

- 来源界面当前只提供 RSS/Atom 与 GitHub 仓库，没有 X 专用配置。
- 后端 `platform` 只是请求一个 URL、截取响应前 5000 字符作为摘要；没有 X 登录、账号动态、分页、增量游标或线程处理。
- 现有 RSS 链路已经包含抓取、Feed 解析、候选准入、补抓、正文存储和初审，可以作为接入基础。
- `workers/python` 是 OpenLore 自己写的子进程封装，内部使用 `feedparser`、`trafilatura` 和 `jsonschema` 开源库；它不是现成的 X 采集服务。
- 尚未确认可直接使用的 X 官方 RSS。当前研究方向依赖第三方转换或自建采集，不应宣称 X 已提供可用 RSS。

主要源码：

- `apps/web/src/features/sources/SourcesPage.tsx`
- `apps/server/src/modules/collection/collectors/platform/adapter.ts`
- `apps/server/src/modules/collection/collectors/web_feed/adapter.ts`
- `apps/server/src/modules/collection/quality.ts`
- `apps/server/src/infrastructure/http/client.ts`
- `workers/python/pyproject.toml`

## 候选方案与已有证据

以下是初步调研记录，不代表最终选型或实测结果。

| 候选 | 用法 | 已核查内容 | 尚待验证 |
| --- | --- | --- | --- |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 中间服务输出 RSS，OpenLore 直接订阅 | 阅读项目 README；X 路由源码请求未成功，GitHub API 也遇到限流 | 当前 X 路由、凭据要求、部署方式和连续可用性 |
| [twscrape](https://github.com/vladkens/twscrape) | Python 获取动态，再转 RSS，或后续评估直接适配 | README 说明需要已授权 X 账号，支持 Cookie 会话、用户动态和搜索 | 实际登录、限流、输出完整性、维护成本；RSS 输出需另做 |
| [Twikit](https://github.com/d60/twikit) | Python 登录并获取用户动态 | README 示例包含登录和 Cookie 文件，不要求官方 API Key | 当前接口可用性、会话维护；RSS 输出需另做 |
| [Nitter](https://github.com/zedeus/nitter) | 使用实例提供的 RSS | README 说明 RSS 依实例配置，部分关闭；项目公告存在持续运营不确定性 | 实例可用性和维护情况；暂不列为首选 |

上述文档于 2026-10-23 在线读取，未固定上游源码快照，也未使用真实 X 账号进行测试。“开源”和“无需官方 API Key”不表示无需账号、无需维护或一定稳定。

2026-10-24 补充：已成功读取 RSSHub `twitter/user.ts`、`namespace.ts`、`api/index.ts`，确认用户时间线路由存在，认证可走 Web Cookie 或开发者 API。此前路由未确认的记录为历史状态；最新证据和实施方案见 [上下文](01-context-brief.md)、[方案比较](02-options.md)、[详细设计](03-design.md)与[测试计划](04-test-plan.md)。实际采集仍未验证。

## 首轮验证建议范围

下面是待验证的最小范围，不视为已经批准的开发方案：

1. 选择 2～3 个技术账号，验证获取动态及持续更新。
2. 核对帖子 ID、作者、原帖链接、原始发布时间、完整正文和外链。
3. 输出标准 RSS/Atom，重复抓取保持条目身份稳定，验证 OpenLore 不重复入池。
4. 检查短帖、线程、转帖与引用帖是否符合现有准入规则，记录被拒原因。
5. 跑通内容池、初审、研究和归档，确认没有把抓取时间误作发布时间。

线程合并、短帖单独研究、外链文章研究和多媒体理解的最终范围尚未确定；关键词全网搜索与大规模账号采集也未确定。

## 已知接入障碍

| 障碍 | 对验证的影响 |
| --- | --- |
| 短帖与长文章准入规则不同 | 正文长度、完整度和日期证据规则可能把有效帖子拒收，或触发对 X 网页的无效补抓 |
| RSS 只有摘要 | 现有补抓会访问原网页；不保证能从 X 页面补出完整正文 |
| 本机/内网中间服务 | `SafeHttpClient` 默认阻止部分私网目标，不能假设本机 RSS URL 能直接访问；应评估明确的可信来源配置 |
| 凭据和会话依赖 | 第三方采集器可能需要登录 Cookie；凭据应留在受控环境，不进入 Git 或 PR |
| 帖子与外链文章身份 | 需要决定保存帖子、研究外链还是两者关联，避免重复和来源丢失 |

## 当前进度

- 已克隆原项目，并完成核心链路源码分析。
- 用户已创建个人 Fork，本地 `origin` 指向 `kkcaideyi/openlore`，`upstream` 指向原项目。
- 已建立本需求分支，在 `D:\Project\openlore` 集中保存总体分析和本需求记录；不使用单独工作树。
- 未安装第三方采集器、部署 RSS 服务、采集真实 X 数据或启动业务验证。
- 两份原始文档已提交到需求分支；2026-10-24 本地可见该分支跟踪 origin 同名分支且 HEAD 一致。后续方案文档尚未提交；未修改应用源码或创建 PR。

## 下一步与待确定事项

优先验证 RSSHub 或其他可用 X→RSS 服务；如不可用，再用 twscrape/Twikit 做小规模对照验证。

待确定：关注账号清单、可用部署机器、网络条件、是否可使用 X 登录会话、首版处理帖子还是外链文章。

根据验证结果确定 PR 范围：现有 RSS 链路足够时可先贡献接入文档；如遇准入、可信来源或数据转换问题，再设计针对性改动。
