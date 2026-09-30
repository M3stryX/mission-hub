#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

TABLES = [
    "missions",
    "mission_checklist_items",
    "mission_sources",
    "mission_events",
    "cursor_sessions",
]

def read_table(connection, table):
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table,),
    ).fetchone()
    if not exists:
        return []

    rows = [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')]
    if table == "mission_checklist_items":
        for row in rows:
            row["done"] = bool(row.get("done"))
    if table == "mission_events":
        for row in rows:
            payload = row.get("payload")
            if isinstance(payload, str):
                try:
                    row["payload"] = json.loads(payload)
                except json.JSONDecodeError:
                    row["payload"] = {"legacy_raw": payload}
    return rows

def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: export-legacy-sqlite.py SOURCE_DB OUTPUT_JSON")

    source = os.path.abspath(sys.argv[1])
    output = os.path.abspath(sys.argv[2])
    connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row

    try:
        bundle = {
            "format": "mission-hub-legacy-export-v1",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_basename": os.path.basename(source),
        }
        for table in TABLES:
            bundle[table] = read_table(connection, table)

        with open(output, "w", encoding="utf-8") as handle:
            json.dump(bundle, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    finally:
        connection.close()

if __name__ == "__main__":
    main()
