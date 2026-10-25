"""X account timeline collection (optional `x` extra, backed by twscrape)."""

import os
from pathlib import Path

# twscrape reports usage telemetry unless disabled; set before it is imported anywhere.
os.environ["TWS_TELEMETRY"] = "0"


def default_accounts_db() -> str:
    data_dir = os.environ.get("OPENLORE_DATA_DIR") or str(Path.home() / ".openlore")
    return str(Path(data_dir) / "x" / "accounts.db")
