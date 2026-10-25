# openlore-collectors

Python collectors for OpenLore (RSS/Atom parsing via feedparser, web page text extraction via Trafilatura, optional X account timelines via twscrape).

## X 账号来源（可选）

```bash
uv sync --extra x
# Cookie 从 stdin 或隐藏输入读取，须含 auth_token 和 ct0；不要写进命令行参数
uv run python -m openlore_collectors.x_user.accounts add <登录名> < cookies.txt
uv run python -m openlore_collectors.x_user.accounts list
```

- 会话库默认 `$OPENLORE_DATA_DIR/x/accounts.db`（未设置时 `~/.openlore/x/accounts.db`），仅控制端读取，不发给 AI 执行机。POSIX 下设为 0600；Windows 依赖用户目录 ACL。
- 每次采集：1 次账号查询 + 最多 3 页时间线，50 秒软截止；限流、会话失效、无会话分别返回错误，限流时来源进入冷却。
- 只收录该账号原创帖、引用帖和自串回复；转帖、对他人的回复不收录。不回抓 X 网页，不做视频/图片转写。
- 已禁用 twscrape 默认开启的遥测（`TWS_TELEMETRY=0`）。
