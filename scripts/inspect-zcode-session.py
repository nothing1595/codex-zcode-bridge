#!/usr/bin/env python3
"""Inspect recent ZCode session/message shapes for bridge development."""

import json
import re
import sqlite3
import sys
from pathlib import Path


workspace = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else None
database = Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row

query = "SELECT id, directory, title, time_created, time_updated, task_type FROM session"
params = []
if workspace:
    query += " WHERE lower(directory) = lower(?) OR lower(path) = lower(?)"
    params.extend([workspace, workspace])
query += " ORDER BY time_updated DESC LIMIT 8"
sessions = [dict(row) for row in connection.execute(query, params)]
print(json.dumps({"sessions": sessions}, ensure_ascii=False, indent=2))

if sessions:
    session_id = sessions[0]["id"]
    for table in ("message", "part"):
        rows = connection.execute(
            f'SELECT id, time_created, time_updated, data, sequence FROM "{table}" WHERE session_id = ? ORDER BY sequence',
            (session_id,),
        )
        summaries = []
        for row in rows:
            try:
                data = json.loads(row["data"])
            except Exception:
                data = {"raw_type": type(row["data"]).__name__}
            serialized = json.dumps(data, ensure_ascii=False)
            serialized = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED_JWT]", serialized)
            summaries.append({
                "id": row["id"],
                "sequence": row["sequence"],
                "data_preview": serialized[:1000],
            })
        print(json.dumps({"session_id": session_id, "table": table, "rows": summaries}, ensure_ascii=False, indent=2))

connection.close()
