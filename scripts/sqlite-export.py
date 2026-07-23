#!/usr/bin/env python3
"""Create a consistent SQLite snapshot and emit selected tables as JSON."""

from __future__ import annotations

import argparse
import base64
import json
import sqlite3
from pathlib import Path
from typing import Any


def encode(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"__base64": base64.b64encode(value).decode("ascii")}
    return value


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--tables", required=True, help="Comma-separated table allowlist")
    args = parser.parse_args()

    source_path = Path(args.source).expanduser().resolve()
    snapshot_path = Path(args.snapshot).expanduser().resolve()
    if not source_path.is_file():
        raise SystemExit(f"SQLite source does not exist: {source_path}")
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    if snapshot_path.exists():
        snapshot_path.unlink()

    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    snapshot = sqlite3.connect(snapshot_path)
    try:
        source.backup(snapshot)
    finally:
        snapshot.close()
        source.close()

    connection = sqlite3.connect(f"file:{snapshot_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        available = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        payload: dict[str, Any] = {
            "source": str(source_path),
            "snapshot": str(snapshot_path),
            "tables": {},
        }
        for table in [item for item in args.tables.split(",") if item]:
            if table not in available:
                continue
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({quote_identifier(table)})")]
            rows = []
            for row in connection.execute(f"SELECT * FROM {quote_identifier(table)}"):
                rows.append({key: encode(row[key]) for key in row.keys()})
            payload["tables"][table] = {"columns": columns, "rows": rows}
        print(json.dumps(payload, separators=(",", ":")))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
