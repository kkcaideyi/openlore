import asyncio
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

pytest.importorskip("twscrape")

from twscrape import AccountsPool  # noqa: E402
from twscrape.accounts_pool import NoAccountError  # noqa: E402
from twscrape.models import parse_users  # noqa: E402

from openlore_collectors.protocol import XUserRequest  # noqa: E402
from openlore_collectors.x_user.collector import collect_user  # noqa: E402

EPOCH_MS = 1288834974657
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def post_id(minutes_ago: int) -> int:
    ms = int((NOW - timedelta(minutes=minutes_ago)).timestamp() * 1000)
    return (ms - EPOCH_MS) << 22


def gql_user(uid: int, handle: str, pinned=()):
    return {
        "__typename": "User",
        "rest_id": str(uid),
        "core": {"screen_name": handle, "name": handle.title(), "created_at": "Mon Jan 01 00:00:00 +0000 2020"},
        "legacy": {"pinned_tweet_ids_str": [str(x) for x in pinned]},
    }


def gql_tweet(tid, author, text, *, reply_to=None, quoted=None, retweeted=None, urls=(), photos=()):
    created = datetime.fromtimestamp(((tid >> 22) + EPOCH_MS) / 1000, timezone.utc)
    legacy = {
        "id_str": str(tid),
        "created_at": format_datetime(created),
        "full_text": text,
        "conversation_id_str": str(reply_to[0] if reply_to else tid),
        "user_id_str": author["rest_id"],
        "lang": "en",
        "entities": {"urls": [{"url": t, "expanded_url": e, "display_url": e[8:30]} for t, e in urls]},
        "extended_entities": {"media": [{"type": "photo", "media_url_https": p} for p in photos]},
    }
    obj = {"__typename": "Tweet", "rest_id": str(tid), "core": {"user_results": {"result": author}}, "legacy": legacy}
    if reply_to:
        legacy.update(in_reply_to_status_id_str=str(reply_to[0]), in_reply_to_user_id_str=reply_to[1]["rest_id"],
                      in_reply_to_screen_name=reply_to[1]["core"]["screen_name"])
    if quoted:
        legacy["quoted_status_id_str"] = quoted["rest_id"]
        obj["quoted_status_result"] = {"result": quoted}
    if retweeted:
        legacy["retweeted_status_result"] = {"result": retweeted}
    return obj


def page(*tweets, cursor="next"):
    entries = [{"entryId": f"tweet-{t['rest_id']}", "content": {"itemContent": {"tweet_results": {"result": t}}}} for t in tweets]
    if cursor:
        entries.append({"entryId": "cursor-bottom-0", "content": {"cursorType": "Bottom", "value": cursor}})
    instructions = [{"type": "TimelineAddEntries", "entries": entries}]
    return {"data": {"user": {"result": {"timeline": {"timeline": {"instructions": instructions}}}}}}


class Rep:
    def __init__(self, obj):
        self.obj = obj

    def json(self):
        return self.obj


class FakeApi:
    def __init__(self, user, pages, delay=0.0):
        self.user = user
        self.pages = pages
        self.delay = delay
        self.calls = []
        self.closed = False

    async def user_by_login(self, handle):
        return self.user

    async def user_tweets_raw(self, uid, kv=None):
        self.calls.append(kv)
        try:
            for item in self.pages:
                await asyncio.sleep(self.delay)
                if isinstance(item, Exception):
                    raise item
                yield Rep(item)
        finally:
            self.closed = True


AUTHOR = gql_user(1, "builder")
OTHER = gql_user(2, "someone")


def user(pinned=()):
    return next(iter(parse_users({"data": {"user": {"result": gql_user(1, "builder", pinned)}}})))


def request(state=None, pages=2, deadline=10.0, db="missing.db"):
    return XUserRequest(1, "job-x", "builder", db, state or {}, pages, deadline)


def test_normalizes_own_posts_and_drops_retweets_replies_and_foreign_posts():
    quoted = gql_tweet(post_id(90), OTHER, "Original benchmark details from another account")
    pinned = gql_tweet(post_id(60 * 24 * 90), AUTHOR, "Pinned intro post")
    timeline = page(
        pinned,
        gql_tweet(post_id(10), AUTHOR, "Read the eval write-up https://t.co/abc &amp; notes https://t.co/media",
                  urls=[("https://t.co/abc", "https://example.com/evals")], photos=["https://pbs.twimg.com/a.jpg"]),
        gql_tweet(post_id(11), AUTHOR, "Self thread continuation", reply_to=(post_id(10), AUTHOR)),
        gql_tweet(post_id(12), AUTHOR, "Reply to someone else", reply_to=(post_id(100), OTHER)),
        gql_tweet(post_id(13), AUTHOR, "RT @someone: x", retweeted=gql_tweet(post_id(200), OTHER, "x")),
        gql_tweet(post_id(14), AUTHOR, "Worth reading", quoted=quoted),
        cursor=None,
    )
    resp = collect_user(request(), FakeApi(user(pinned=[pinned["rest_id"]]), [timeline])).to_dict()

    assert resp["status"] == "success" and resp["job_id"] == "job-x"
    posts = {p["text"]: p for p in resp["data"]["posts"]}
    assert set(posts) == {
        "Pinned intro post",
        "Read the eval write-up https://example.com/evals & notes",
        "Self thread continuation",
        "Worth reading",
    }
    first = posts["Read the eval write-up https://example.com/evals & notes"]
    assert first["links"] == [{"url": "https://example.com/evals", "display": "example.com/evals"}]
    assert first["media"] == [{"kind": "photo", "url": "https://pbs.twimg.com/a.jpg"}]
    assert first["created_at"].endswith("Z") and first["author"] == {"id": "1", "handle": "builder", "name": "Builder"}
    assert posts["Self thread continuation"]["in_reply_to"]["handle"] == "builder"
    assert posts["Worth reading"]["quoted"]["author"]["handle"] == "someone"
    assert posts["Pinned intro post"]["pinned"] is True
    # The old pinned post neither counts as the newest post nor ends the scan.
    assert resp["data"]["next_state"] == {"user_id": "1", "newest_id": str(post_id(10)), "pending": None}
    assert resp["data"]["scan"] == "complete"


def test_stops_at_watermark_and_keeps_pinned_out_of_boundary():
    pinned = gql_tweet(post_id(60 * 24 * 30), AUTHOR, "Pinned")
    api = FakeApi(user(pinned=[pinned["rest_id"]]), [
        page(pinned, gql_tweet(post_id(1), AUTHOR, "new")),
        page(gql_tweet(post_id(5), AUTHOR, "known")),
        page(gql_tweet(post_id(9), AUTHOR, "never requested")),
    ])
    resp = collect_user(request({"user_id": "1", "newest_id": str(post_id(5))}, pages=5), api).to_dict()
    data = resp["data"]
    assert data["scan"] == "complete" and data["requests"] == 3
    assert data["next_state"]["newest_id"] == str(post_id(1))
    assert [p["text"] for p in data["posts"]] == ["new"]  # posts at or below the watermark were already delivered
    assert api.closed


def test_budget_exhaustion_keeps_watermark_and_resumes_from_cursor():
    state = {"user_id": "1", "newest_id": str(post_id(500)), "pending": None}
    first = collect_user(request(state, pages=1), FakeApi(user(), [page(gql_tweet(post_id(1), AUTHOR, "a"), cursor="c1")])).to_dict()["data"]
    assert first["scan"] == "more"
    assert first["next_state"] == {
        "user_id": "1",
        "newest_id": str(post_id(500)),
        "pending": {"cursor": "c1", "top_id": str(post_id(1)), "stop_id": str(post_id(500))},
    }

    api = FakeApi(user(), [page(gql_tweet(post_id(400), AUTHOR, "b"), gql_tweet(post_id(600), AUTHOR, "old"))])
    second = collect_user(request(first["next_state"], pages=1), api).to_dict()["data"]
    assert api.calls == [{"cursor": "c1"}]
    assert second["scan"] == "complete"
    assert [p["text"] for p in second["posts"]] == ["b"]
    assert second["next_state"] == {"user_id": "1", "newest_id": str(post_id(1)), "pending": None}


def test_first_scan_does_not_backfill_beyond_budget():
    data = collect_user(request(pages=1), FakeApi(user(), [page(gql_tweet(post_id(3), AUTHOR, "a"))])).to_dict()["data"]
    assert data["scan"] == "limited"
    assert data["next_state"] == {"user_id": "1", "newest_id": str(post_id(3)), "pending": None}


def test_handle_reassigned_to_another_account_resets_checkpoint():
    resp = collect_user(request({"user_id": "999", "newest_id": str(post_id(1))}),
                        FakeApi(user(), [page(gql_tweet(post_id(2), AUTHOR, "a"), cursor=None)])).to_dict()
    assert "x_user_changed" in resp["issues"]
    assert resp["data"]["next_state"]["user_id"] == "1"


def test_failure_after_a_page_returns_partial_items_and_resumable_state():
    state = {"user_id": "1", "newest_id": str(post_id(500))}
    api = FakeApi(user(), [page(gql_tweet(post_id(1), AUTHOR, "kept"), cursor="c1"), RuntimeError("boom")])
    resp = collect_user(request(state, pages=3), api).to_dict()
    assert resp["status"] == "partial"
    assert resp["error"]["code"] == "x_collect_error" and resp["error"]["retryable"] is True
    assert [p["text"] for p in resp["data"]["posts"]] == ["kept"]
    assert resp["data"]["next_state"]["pending"]["cursor"] == "c1"


def test_deadline_returns_before_parent_timeout():
    api = FakeApi(user(), [page(gql_tweet(post_id(1), AUTHOR, "late"))], delay=5)
    resp = collect_user(request(deadline=0.2), api).to_dict()
    assert resp["status"] == "failed" and resp["error"]["code"] == "x_timeout"
    assert api.closed


def test_unknown_user_and_empty_timeline_are_failures_not_empty_successes():
    assert collect_user(request(), FakeApi(None, [])).to_dict()["error"]["code"] == "x_user_unavailable"
    resp = collect_user(request(), FakeApi(user(), [])).to_dict()
    assert resp["status"] == "failed" and resp["error"]["code"] == "x_empty_timeline"


@pytest.fixture
def accounts_db(tmp_path):
    db = tmp_path / "accounts.db"
    asyncio.run(AccountsPool(str(db)).add_account_cookies("reader", "auth_token=a1; ct0=c1"))
    return db


def test_session_problems_are_classified_from_the_account_store(tmp_path, accounts_db):
    missing = collect_user(request(db=str(tmp_path / "none.db"))).to_dict()["error"]
    assert missing["code"] == "x_no_account" and missing["retryable"] is False
    assert not (tmp_path / "none.db").exists()

    con = sqlite3.connect(accounts_db)
    con.execute("UPDATE accounts SET active=0, error_msg='(32) Could not authenticate you'")
    con.commit()
    invalid = collect_user(request(db=str(accounts_db))).to_dict()["error"]
    assert invalid["code"] == "x_auth_invalid" and "Could not authenticate" in invalid["message"]

    unlock = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
    con.execute("UPDATE accounts SET active=1, error_msg=NULL, locks=?", (json.dumps({"UserTweets": unlock}),))
    con.commit()
    con.close()
    api = FakeApi(user(), [NoAccountError("No account available for queue UserTweets")])
    limited = collect_user(request(db=str(accounts_db)), api).to_dict()["error"]
    assert limited["code"] == "x_rate_limited" and limited["retryable"] is True
    assert 540 <= limited["retry_after_seconds"] <= 600


def test_cli_dispatches_x_collection_and_keeps_job_id(tmp_path):
    req = {
        "protocol_version": 1,
        "job_id": "job-cli",
        "operation": "collect_x_user",
        "handle": "builder",
        "accounts_db": str(tmp_path / "accounts.db"),
        "state": {},
        "budget": {"max_pages": 1, "deadline_seconds": 5},
    }
    res = subprocess.run([sys.executable, "-m", "openlore_collectors"], input=json.dumps(req), capture_output=True, text=True)
    out = json.loads(res.stdout)
    assert res.returncode == 0
    assert out["job_id"] == "job-cli" and out["error"]["code"] == "x_no_account"
