"""Clone only the known default QA's synthetic DB and seed a schema-4 upgrade."""
from pathlib import Path
import json
import hashlib
import os
import sqlite3
import subprocess
import sys
import uuid

REPO=Path(__file__).resolve().parents[1]
QA=REPO/'output/optimization/QA-notes-20261007'
ROOT=QA/'search-runtime-qa'
info=json.loads((QA/'process.json').read_text(encoding='utf-8-sig'))
assert info['identifier']=='com.copycreator.qa20261007'
source=(Path(info['storageRoot'])/'data.db').resolve()
assert source.is_relative_to(QA.resolve())
target=ROOT/'migration-incoming/data.db'
assert not target.exists()
target.parent.mkdir(exist_ok=True)
with sqlite3.connect('file:'+source.as_posix()+'?mode=ro',uri=True) as source_db:
    assert source_db.execute('PRAGMA user_version').fetchone()[0]==4
    with sqlite3.connect(target) as dest:
        source_db.backup(dest)
        dest.execute("DELETE FROM settings WHERE key IN ('storage_path','shortcut_key')")
prefix='QA-scale-migration-'+str(uuid.uuid4())
request={'action':'scale_load','database':str(target),'prefix':prefix,'count':50000}
fixture=json.loads(subprocess.check_output([sys.executable,str(REPO/'scripts/qa-storage-fixture.py')],input=json.dumps(request),encoding='utf-8'))
with sqlite3.connect(target) as conn:
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    digests={}
    for table in ('notes','note_refs','note_import_origins'):
        digest=hashlib.sha256()
        for row in conn.execute('SELECT * FROM '+table+' ORDER BY 1,2'):
            digest.update(json.dumps(row,ensure_ascii=False,separators=(',',':')).encode('utf-8'))
            digest.update(b'\n')
        digests[table]=digest.hexdigest()
    report={'schema':conn.execute('PRAGMA user_version').fetchone()[0],
            'notes':conn.execute('SELECT count(*) FROM notes').fetchone()[0],
            'databaseBytes':target.stat().st_size,'prefix':prefix,'fixture':fixture,'contentDigests':digests}
run_id=os.environ['QA_MIGRATION_RUN_ID']
assert run_id.startswith('migration-') and all(c.isalnum() or c=='-' for c in run_id)
(ROOT/(run_id+'-fixture.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
