"""Synthetic shared corpus restricted to the runtime-baseline identity."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

root = Path(__file__).resolve().parents[1] / 'output/optimization/baseline-runtime-20261008'
metadata = json.loads((root / 'process.json').read_text(encoding='utf-8-sig'))
assert metadata['identifier'] == 'com.copycreator.qabaseline20261008v2'
assert metadata['generation'] == 2 and metadata['pasteIsolation'] == metadata['autostartIsolation'] == 'identifier'
database = Path(os.environ['APPDATA']) / metadata['identifier'] / 'data.db'
assert Path(metadata['storageRoot']).resolve() == database.parent.resolve()
assert database.exists()
action = sys.argv[1]
assert action in ('seed', 'inspect')
with sqlite3.connect(database, timeout=10) as conn:
    conn.execute('PRAGMA foreign_keys=ON')
    if action == 'seed':
        assert not conn.execute("SELECT 1 FROM clipboard_records WHERE source_app NOT IN ('QA common runtime','') AND content NOT LIKE 'QA controlled clipboard %' LIMIT 1").fetchone()
        conn.execute("INSERT INTO settings(key,value) VALUES('max_history_items','5000') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        conn.execute("INSERT INTO settings(key,value) VALUES('max_storage_mb','1024') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        for index in range(2000):
            identity = str(uuid.uuid5(uuid.NAMESPACE_URL, 'copy-creator-qa-common-runtime-' + str(index)))
            text = 'QA common runtime ' + str(index) + '\n' + ('中文 mixed text https://example.invalid/ raw  \r\n' * (16 + index % 48))
            conn.execute("INSERT OR IGNORE INTO clipboard_records(id,type,content,source_app,created_at) VALUES(?,'text',?,'QA common runtime','2099-01-01T00:00:00Z')", [identity,text])
    rows = conn.execute("SELECT id,type,content,source_app,created_at,is_favorite,favorite_note,user_api_key FROM clipboard_records WHERE source_app='QA common runtime' ORDER BY id").fetchall()
    assert len(rows) == 2000
    result = {'records': len(rows), 'sha256': hashlib.sha256(json.dumps(rows,ensure_ascii=True).encode()).hexdigest(), 'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0]}
    assert result['integrity'] == 'ok'
    print(json.dumps(result))
