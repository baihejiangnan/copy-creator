"""Set only the isolated QA automatic-update flag; caller checks processes stopped."""
import json
from pathlib import Path
import sqlite3
import sys

root = Path(__file__).resolve().parents[1] / 'output/optimization/QA-notes-20261007'
value = sys.argv[1]
assert value in ('0', '1')
info = json.loads((root / 'process.json').read_text(encoding='utf-8-sig'))
assert info['identifier'] == 'com.copycreator.qa20261007'
database = (Path(info['storageRoot']) / 'data.db').resolve()
assert database.is_relative_to(root.resolve()) and database.is_file()
with sqlite3.connect(database) as connection:
    previous = connection.execute("SELECT value FROM settings WHERE key='auto_check_updates'").fetchone()
    connection.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_check_updates',?)", (value,))
    print(json.dumps({'syntheticQaAutoUpdatesBefore': previous[0] if previous else None, 'after': value}))
