#!/usr/bin/env python3
"""Print ZCode SQLite schemas without reading credential values."""

import json
import sqlite3
from pathlib import Path


DATABASES = [
    Path.home() / ".zcode" / "cli" / "db" / "db.sqlite",
    Path.home() / ".zcode" / "v2" / "tasks-index.sqlite",
]


for database in DATABASES:
    print(f"DB {database}")
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for table in tables:
        columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
        print(json.dumps({"table": table, "columns": columns}, ensure_ascii=False))
    connection.close()
