"""Bounded, checkpointed collection of one X account's own posts."""

import asyncio
import html
import json
import math
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from openlore_collectors.protocol import WorkerError, WorkerResponse, XUserRequest

TCO = re.compile(r"https?://t\.co/\w+")
STATUS = re.compile(r"/status(?:es)?/(\d+)")
QUEUE = re.compile(r"queue (\w+)")


class CollectError(Exception):
    def __init__(self, code: str, message: str, retryable: bool, retry_after: Optional[int] = None):
        super().__init__(message)
        self.error = WorkerError(code=code, message=message, retryable=retryable, retry_after_seconds=retry_after)


def read_accounts(db_path: str) -> List[Dict[str, Any]]:
    """Read session status without creating the database or touching cookies."""
    path = Path(db_path)
    if not path.is_file():
        return []
    try:
        con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT active, locks, error_msg FROM accounts").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []
    return [{"active": bool(r[0]), "locks": json.loads(r[1] or "{}"), "error_msg": r[2]} for r in rows]


def unavailable(db_path: str, queue: Optional[str] = None) -> CollectError:
    accounts = read_accounts(db_path)
    if not accounts:
        return CollectError("x_no_account", "未导入 X 会话，请在控制端运行 openlore_collectors.x_user.accounts add 导入", False)
    active = [a for a in accounts if a["active"]]
    if not active:
        reason = next((a["error_msg"] for a in accounts if a["error_msg"]), None)
        suffix = f"：{str(reason)[:120]}" if reason else ""
        return CollectError("x_auth_invalid", f"X 会话已失效，请重新导入 Cookie{suffix}", False)
    now = datetime.now(timezone.utc)
    waits = []
    for account in active:
        for name, until in account["locks"].items():
            if queue and name != queue:
                continue
            try:
                unlock_at = datetime.fromisoformat(until).replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                continue
            if unlock_at > now:
                waits.append((unlock_at - now).total_seconds())
    retry = max(60, int(min(waits))) if waits else 60
    return CollectError("x_rate_limited", f"X 会话限流或被占用，约 {math.ceil(retry / 60)} 分钟后重试", True, retry)


def classify(exc: BaseException, db_path: str) -> CollectError:
    if isinstance(exc, CollectError):
        return exc
    name = type(exc).__name__
    if name == "NoAccountError":
        match = QUEUE.search(str(exc))
        return unavailable(db_path, match.group(1) if match else None)
    if name == "GqlFeaturesOutdatedError":
        return CollectError("x_api_changed", "X 接口已变更，需要升级 twscrape", False)
    if isinstance(exc, TimeoutError):
        return CollectError("x_timeout", "X 采集超过本次时间预算", True)
    return CollectError("x_collect_error", f"{name}: {str(exc)[:200]}", True)


def make_api(db_path: str) -> Any:
    from twscrape import API
    from twscrape.logger import set_log_level

    set_log_level("ERROR")
    # No waiting inside the worker: a locked or missing session is reported to the scheduler.
    return API(db_path, raise_when_no_account=True)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def user_ref(user: Any) -> Dict[str, str]:
    return {"id": user.id_str, "handle": user.username, "name": user.displayname}


def post_text(tweet: Any) -> str:
    text = html.unescape(tweet.rawContent or "")
    for link in tweet.links or []:
        if link.tcourl:
            text = text.replace(link.tcourl, link.url)
    # Remaining t.co links point at attached media or the quoted post, both kept as structured fields.
    return TCO.sub("", text).strip()


def core(tweet: Any) -> Dict[str, Any]:
    return {
        "id": tweet.id_str,
        "url": tweet.url,
        "created_at": iso(tweet.date),
        "author": user_ref(tweet.user),
        "text": post_text(tweet),
    }


def media(tweet: Any) -> List[Dict[str, str]]:
    items = [{"kind": "photo", "url": photo.url} for photo in tweet.media.photos]
    for video in tweet.media.videos:
        best = max(video.variants, key=lambda variant: variant.bitrate, default=None)
        items.append({"kind": "video", "url": best.url if best else video.thumbnailUrl})
    items += [{"kind": "animated_gif", "url": gif.videoUrl} for gif in tweet.media.animated]
    return items


def post_record(tweet: Any, pinned: bool) -> Dict[str, Any]:
    quoted = tweet.quotedTweet
    links = [
        {"url": link.url, "display": link.text}
        for link in tweet.links or []
        if not quoted or quoted.id_str not in STATUS.findall(link.url)
    ]
    reply = None
    if tweet.inReplyToTweetIdStr:
        handle = tweet.inReplyToUser.username if tweet.inReplyToUser else tweet.inReplyToScreenName
        reply = {"post_id": tweet.inReplyToTweetIdStr, "handle": handle}
    return {
        **core(tweet),
        "lang": tweet.lang or None,
        "conversation_id": tweet.conversationIdStr,
        "in_reply_to": reply,
        "quoted": core(quoted) if quoted else None,
        "links": links,
        "media": media(tweet),
        "pinned": pinned,
    }


def replies_to_other(tweet: Any, user: Any) -> bool:
    if not tweet.inReplyToTweetIdStr:
        return False
    if tweet.inReplyToUser:
        return tweet.inReplyToUser.id != user.id
    return (tweet.inReplyToScreenName or "").lower() != user.username.lower()


def bottom_cursor(obj: Any) -> Optional[str]:
    stack = [obj]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get("cursorType") == "Bottom" and isinstance(node.get("value"), str):
                return node["value"]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None


def collect_user(req: XUserRequest, api: Any = None) -> WorkerResponse:
    return asyncio.run(_collect(req, api))


async def _collect(req: XUserRequest, api: Any) -> WorkerResponse:
    deadline = time.monotonic() + req.deadline_seconds
    issues: List[str] = []

    def remaining() -> float:
        return max(0.1, deadline - time.monotonic())

    def respond(status: str, data: Any = None, error: Optional[CollectError] = None) -> WorkerResponse:
        return WorkerResponse(
            protocol_version=1,
            job_id=req.job_id,
            status=status,
            data=data,
            issues=issues,
            error=error.error if error else None,
        )

    try:
        if api is None:
            if not any(account["active"] for account in read_accounts(req.accounts_db)):
                raise unavailable(req.accounts_db)
            try:
                api = make_api(req.accounts_db)
            except ImportError:
                raise CollectError("x_dependency_missing", "未安装 X 采集依赖，请在 workers/python 运行 uv sync --extra x", False)
        from twscrape.models import parse_tweets

        user = await asyncio.wait_for(api.user_by_login(req.handle), remaining())
    except Exception as exc:
        return respond("failed", error=classify(exc, req.accounts_db))
    if user is None:
        return respond("failed", error=CollectError(
            "x_user_unavailable", f"无法读取 @{req.handle}：账号不存在、已停用、受保护或请求被拦截", True))

    state = {key: req.state.get(key) for key in ("user_id", "newest_id", "pending")}
    if state["user_id"] and state["user_id"] != user.id_str:
        # The handle now belongs to another account; old checkpoints are meaningless.
        state = {"user_id": None, "newest_id": None, "pending": None}
        issues.append("x_user_changed")
    pending = state["pending"]
    stop_id = int(pending["stop_id"]) if pending else int(state["newest_id"]) if state["newest_id"] else None
    top_id = int(pending["top_id"]) if pending else 0
    cursor = pending["cursor"] if pending else None
    pinned = set(user.pinnedIds or [])

    posts: Dict[str, Dict[str, Any]] = {}
    pages = 0
    reached = exhausted = False
    error: Optional[CollectError] = None
    timeline = api.user_tweets_raw(user.id, kv={"cursor": cursor} if cursor else None)
    try:
        while pages < req.max_pages:
            try:
                rep = await asyncio.wait_for(anext(timeline), remaining())
            except StopAsyncIteration:
                exhausted = True
                break
            pages += 1
            obj = rep.json()
            for tweet in parse_tweets(obj):
                # Responses also carry quoted and retweeted posts by other accounts.
                if tweet.user.id != user.id:
                    continue
                is_pinned = tweet.id in pinned
                if not is_pinned:
                    top_id = max(top_id, tweet.id)
                    reached = reached or (stop_id is not None and tweet.id <= stop_id)
                known = stop_id is not None and tweet.id <= stop_id
                if known or tweet.retweetedTweet or replies_to_other(tweet, user):
                    continue
                posts[tweet.id_str] = post_record(tweet, is_pinned)
            cursor = bottom_cursor(obj)
            exhausted = cursor is None
            if reached or exhausted:
                break
    except Exception as exc:
        error = classify(exc, req.accounts_db)
    finally:
        try:
            await timeline.aclose()
        except Exception:
            pass

    complete = reached or exhausted
    if pages == 0 and error:
        return respond("failed", error=error)
    if pages == 0 and not pending:
        # twscrape turns blocked or unparsable responses into an empty timeline.
        return respond("failed", error=CollectError(
            "x_empty_timeline", f"X 未返回 @{req.handle} 的任何帖子：无公开帖子、受保护或请求被拦截", True))
    if pages == 0:
        issues.append("x_continuation_empty")

    if complete:
        newest = max(int(state["newest_id"] or 0), top_id)
        next_state = {"user_id": user.id_str, "newest_id": str(newest) if newest else None, "pending": None}
        scan = "complete"
    elif stop_id is None:
        # First scan: older history beyond the page budget is intentionally not backfilled.
        next_state = {"user_id": user.id_str, "newest_id": str(top_id) if top_id else None, "pending": None}
        scan = "limited"
    else:
        next_state = {
            "user_id": user.id_str,
            "newest_id": state["newest_id"],
            "pending": {"cursor": cursor, "top_id": str(top_id), "stop_id": str(stop_id)},
        }
        scan = "more"
    data = {
        "user": user_ref(user),
        "posts": sorted(posts.values(), key=lambda post: int(post["id"]), reverse=True),
        "next_state": next_state,
        "scan": scan,
        "requests": 1 + pages,
        "issues": issues,
    }
    return respond("partial" if error else "success", data, error)
