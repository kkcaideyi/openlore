"""Manage the X session store used by collect_x_user.

  python -m openlore_collectors.x_user.accounts add <username> < cookies.txt
  python -m openlore_collectors.x_user.accounts list
  python -m openlore_collectors.x_user.accounts remove <username>

Cookies (must include auth_token and ct0) are read from stdin or a hidden prompt, never from argv.
"""

import argparse
import asyncio
import getpass
import os
import sys
from pathlib import Path

from openlore_collectors.x_user import default_accounts_db


def restrict(db_path: Path) -> None:
    # POSIX only. On Windows the file inherits the per-user profile ACL of the data directory.
    if os.name == "posix":
        os.chmod(db_path.parent, 0o700)
        if db_path.exists():
            os.chmod(db_path, 0o600)


async def run(args: argparse.Namespace) -> int:
    from twscrape import AccountsPool
    from twscrape.logger import set_log_level

    set_log_level("WARNING")
    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    pool = AccountsPool(str(db_path))
    if args.command == "add":
        cookies = sys.stdin.read() if not sys.stdin.isatty() else getpass.getpass("Cookie (auth_token=...; ct0=...): ")
        await pool.add_account_cookies(args.username, cookies.strip())
        restrict(db_path)
        print(f"已保存 X 会话：{args.username}")
    elif args.command == "remove":
        await pool.delete_accounts(args.username)
        print(f"已删除 X 会话：{args.username}")
    else:
        for info in await pool.accounts_info():
            state = "可用" if info["active"] else f"失效 {info['error_msg']}"
            print(f"{info['username']}\t{state}\t请求 {info['total_req']}\t最近使用 {info['last_used'] or '-'}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="openlore_collectors.x_user.accounts")
    parser.add_argument("--db", default=default_accounts_db(), help="默认 $OPENLORE_DATA_DIR/x/accounts.db")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("add").add_argument("username")
    commands.add_parser("remove").add_argument("username")
    commands.add_parser("list")
    args = parser.parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except ValueError as exc:
        sys.exit(f"失败：{exc}")


if __name__ == "__main__":
    main()
