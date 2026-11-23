import json
import sqlite3
import sys
from urllib.parse import urlparse


def origin_key(value: str):
    try:
        parsed = urlparse(value)
        host = parsed.hostname
        if parsed.scheme != "https" or not host or parsed.username is not None:
            return None
        port = parsed.port
        host = f"[{host}]" if ":" in host else host
        return f"https://{host}:{port}" if port not in (None, 443) else f"https://{host}"
    except ValueError:
        return None


if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] != "--exact-origins"):
    raise SystemExit("usage: Sync-ChromeSavedLogins.py <source> <target> <allowed-hosts> [--exact-origins]")

source_path, target_path, allowed_value = sys.argv[1:4]
exact_origins = len(sys.argv) == 5


def scope_matches(value: str, allowed: set[str]) -> bool:
    if exact_origins:
        return origin_key(value) in allowed
    try:
        host = (urlparse(value).hostname or "").lower()
    except ValueError:
        return False
    return any(host == entry or host.endswith("." + entry) for entry in allowed)

try:
    allowed_values = json.loads(allowed_value)
except json.JSONDecodeError:
    # Windows PowerShell removes quotes from JSON passed to native programs.
    allowed_values = [item.strip() for item in allowed_value.split(",") if item.strip()]
allowed_scope = {origin_key(str(value)) if exact_origins else str(value).lower() for value in allowed_values if value}
allowed_scope.discard(None)
if not allowed_scope:
    print(json.dumps({"copied": 0, "origins": 0}))
    raise SystemExit(0)

source = sqlite3.connect(
    "file:" + source_path.replace("\\", "/") + "?mode=ro&immutable=1",
    uri=True,
)
target = sqlite3.connect(target_path, timeout=10)
try:
    source_columns = [row[1] for row in source.execute("pragma table_info(logins)")]
    target_columns = [row[1] for row in target.execute("pragma table_info(logins)")]
    columns = [column for column in source_columns if column in target_columns and column != "id"]
    if not columns:
        raise RuntimeError("Chrome Login Data schema is incompatible")

    source_rows = source.execute(
        "select " + ",".join(f'\"{column}\"' for column in columns) + " from logins"
    ).fetchall()
    origin_index = columns.index("origin_url")
    realm_index = columns.index("signon_realm")
    selected_rows = [
        row for row in source_rows
        if scope_matches(str(row[origin_index]), allowed_scope)
        or scope_matches(str(row[realm_index]), allowed_scope)
    ]
    populated_hosts = {
        allowed
        for row in selected_rows
        for allowed in allowed_scope
        if scope_matches(str(row[origin_index]), {allowed})
        or scope_matches(str(row[realm_index]), {allowed})
    }

    target.execute("begin immediate")
    existing = target.execute("select id, origin_url, signon_realm from logins").fetchall()
    delete_ids = [
        row[0] for row in existing
        if scope_matches(str(row[1]), populated_hosts) or scope_matches(str(row[2]), populated_hosts)
    ]
    if delete_ids:
        target.executemany("delete from logins where id = ?", [(value,) for value in delete_ids])

    placeholders = ",".join("?" for _ in columns)
    insert_sql = (
        "insert into logins ("
        + ",".join(f'\"{column}\"' for column in columns)
        + ") values ("
        + placeholders
        + ")"
    )
    target.executemany(insert_sql, selected_rows)
    target.commit()
    print(json.dumps({"copied": len(selected_rows), "origins": len(allowed_scope), "populated_origins": len(populated_hosts)}))
except Exception:
    target.rollback()
    raise
finally:
    target.close()
    source.close()
