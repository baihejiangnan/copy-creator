"""Compare complete synthetic note/ref/origin fields across the QA upgrade."""
from pathlib import Path
import hashlib
import json
import sqlite3
import sys

ROOT=Path(__file__).resolve().parents[1]/'output/optimization/QA-notes-20261007/search-runtime-qa'
run_id=sys.argv[1]
assert run_id.startswith('migration-') and all(c.isalnum() or c=='-' for c in run_id)
before=json.loads((ROOT/(run_id+'-fixture.json')).read_text(encoding='utf-8'))
database=ROOT/'storage/data.db'
with sqlite3.connect(database,timeout=10) as conn:
    assert conn.execute('PRAGMA user_version').fetchone()[0]==5
    digests={}
    for table in ('notes','note_refs','note_import_origins'):
        digest=hashlib.sha256()
        for row in conn.execute('SELECT * FROM '+table+' ORDER BY 1,2'):
            digest.update(json.dumps(row,ensure_ascii=False,separators=(',',':')).encode('utf-8'))
            digest.update(b'\n')
        digests[table]=digest.hexdigest()
    assert digests==before['contentDigests'],'Migration changed a persisted content field'
    counts={table:conn.execute('SELECT count(*) FROM '+table).fetchone()[0]
            for table in ('notes','note_refs','notes_search_ids','note_refs_search_ids')}
    assert counts['notes']==before['notes']==counts['notes_search_ids']
    assert counts['note_refs']==counts['note_refs_search_ids']
    for table in ('notes_search','note_refs_search'):
        conn.execute('INSERT INTO '+table+'('+table+") VALUES('integrity-check')")
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    conn.commit()
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
report={'passed':True,'schema':5,'counts':counts,'contentDigests':digests,
        'beforeDatabaseBytes':before['databaseBytes'],'afterDatabaseBytes':database.stat().st_size,
        'integrity':'ok','ftsIntegrity':'ok','scope':'All notes, refs and restore-origin fields SHA-256 equal; one synthetic upgrade, not real user data or ordinary cold-start acceptance.'}
(ROOT/(run_id+'-verified.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
