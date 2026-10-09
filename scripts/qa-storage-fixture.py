"""Fault injection and inspection restricted to the synthetic QA database."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid
import hashlib
import struct
import zlib
import random

ROOT = Path(__file__).resolve().parents[1] / 'output' / 'optimization'
DEFAULT = Path(os.environ['APPDATA']) / 'com.copycreator.qa20261007'


def guarded(value):
    if value.startswith('\\\\?\\'):
        value = value[4:]
    result = Path(value).resolve()
    if result != DEFAULT.resolve() / 'data.db' and not result.is_relative_to(ROOT.resolve()):
        raise ValueError('Refusing a database outside isolated QA fixtures')
    return result


request = json.load(sys.stdin)
action = request['action']
database = guarded(request['database'])
if action == 'prepare':
    if database.exists():
        raise ValueError('Refusing to overwrite an existing target')
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database) as conn:
        if request['kind'] == 'conflict':
            with sqlite3.connect(guarded(request['source'])) as source:
                schema = source.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'qa_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").fetchall()
                note = source.execute('SELECT * FROM notes WHERE id=?', [request['noteId']]).fetchone()
                assert note is not None
            for (sql,) in schema:
                conn.execute(sql)
            conn.execute('INSERT INTO notes VALUES (' + ','.join('?' for _ in note) + ')', note)
            conn.execute('PRAGMA user_version=4')
        elif request['kind'] == 'clipboard-only':
            with sqlite3.connect(guarded(request['source'])) as source:
                sql = source.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='clipboard_records'").fetchone()[0]
                columns = [row[1] for row in source.execute('PRAGMA table_info(clipboard_records)')]
                record = list(source.execute('SELECT * FROM clipboard_records WHERE id=?', [request['recordId']]).fetchone())
                assert record[columns.index('source_app')].startswith('QA identity event ')
                record[columns.index('is_favorite')] = 0
            conn.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            conn.execute(sql)
            conn.execute('INSERT INTO clipboard_records VALUES (' + ','.join('?' for _ in record) + ')', record)
        else:
            assert request['kind'] == 'empty'
            conn.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        conn.execute("INSERT INTO settings VALUES('qa_existing_target','keep')")
    result = {'prepared': str(database)}
else:
    assert database.exists()
    with sqlite3.connect(database, timeout=10) as conn:
        conn.execute('PRAGMA foreign_keys=ON')
        if action == 'fault':
            conn.execute("CREATE TRIGGER qa_routing_failure BEFORE INSERT ON settings WHEN NEW.key='storage_path' BEGIN SELECT RAISE(ABORT,'QA injected routing failure'); END")
            result = {'installed': True}
        elif action == 'unfault':
            conn.execute('DROP TRIGGER IF EXISTS qa_routing_failure')
            result = {'removed': True}
        elif action == 'paste_temp_retention':
            previous = conn.execute("SELECT value FROM settings WHERE key='clipboard_retention'").fetchone()
            if request['mode'] == 'prepare':
                conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('clipboard_retention','1week')")
                result = {'previous': previous[0] if previous else None}
            else:
                assert request['mode'] == 'restore'
                if request['previous'] is None:
                    conn.execute("DELETE FROM settings WHERE key='clipboard_retention'")
                else:
                    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('clipboard_retention',?)", [request['previous']])
                result = {'restored': True}
        elif action == 'mutation_snapshot':
            result = {'tables': {}, 'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0], 'foreignKeyViolations': len(conn.execute('PRAGMA foreign_key_check').fetchall())}
            for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
                quoted = '"' + table.replace('"', '""') + '"'
                columns = len(conn.execute('PRAGMA table_info(' + quoted + ')').fetchall())
                digest, count = hashlib.sha256(), 0
                for row in conn.execute('SELECT * FROM ' + quoted + ' ORDER BY ' + ','.join(str(i + 1) for i in range(columns))):
                    digest.update(json.dumps(row, ensure_ascii=True, separators=(',', ':'), default=lambda value: value.hex()).encode())
                    digest.update(b'\n')
                    count += 1
                result['tables'][table] = {'count': count, 'sha256': digest.hexdigest()}
        elif action == 'storage_snapshot':
            names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            tables = ['notes', 'note_refs', 'note_import_origins', 'vault_config', 'vault_entries']
            digests, counts = {}, {}
            for table in tables:
                condition = ' WHERE restored_note_id IN (SELECT id FROM notes)' if table == 'note_import_origins' else ''
                rows = conn.execute('SELECT * FROM ' + table + condition + ' ORDER BY 1,2').fetchall() if table in names else []
                digests[table] = hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
                counts[table] = len(rows)
            settings = conn.execute("SELECT key,value FROM settings WHERE key NOT IN ('storage_path','internal_storage_migration_receipt_v1','qa_existing_target','qa_external_target_edit') ORDER BY key").fetchall()
            digests['settings'] = hashlib.sha256(json.dumps(settings, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
            orphan_origins = conn.execute('SELECT COUNT(*) FROM note_import_origins WHERE restored_note_id NOT IN (SELECT id FROM notes)').fetchone()[0] if 'note_import_origins' in names else 0
            result = {'hashes': digests, 'counts': counts, 'orphanOriginsExcluded': orphan_origins, 'foreignKeyViolations': len(conn.execute('PRAGMA foreign_key_check').fetchall()), 'marker': conn.execute("SELECT value FROM settings WHERE key='qa_external_target_edit'").fetchone(), 'targetSetting': conn.execute("SELECT value FROM settings WHERE key='qa_existing_target'").fetchone(), 'hasReceipt': bool(conn.execute("SELECT 1 FROM settings WHERE key='internal_storage_migration_receipt_v1'").fetchone()), 'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0]}
        elif action == 'storage_target_edit':
            assert database.is_relative_to((ROOT / 'QA-notes-20261007' / 'storage-fixtures').resolve())
            conn.execute("INSERT INTO settings(key,value) VALUES('qa_external_target_edit','QA external edit must survive')")
            result = {'edited': True}
        elif action == 'translation_cache':
            assert request['text'].startswith('QA identity translation ') and len(request['text']) < 100
            assert request['result'].startswith('QA old translated result ') and len(request['result']) < 100
            assert request['engine'] in ('google', 'ai')
            conn.execute("INSERT INTO translation_history(id,source_text,target_text,source_lang,target_lang,engine,created_at) VALUES(?,?,?,'auto','zh',?,'2099-01-01 00:00:00')", [request['id'], request['text'], request['result'], request['engine']])
            result = {'inserted': True}
        elif action == 'translation_cache_count':
            assert request['text'].startswith('QA identity translation ') and len(request['text']) < 100
            result = {'count': conn.execute('SELECT COUNT(*) FROM translation_history WHERE source_text=?', [request['text']]).fetchone()[0]}
        elif action == 'history':
            conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at) VALUES(?,'text','QA synthetic history excluded from migration','QA storage fixture','2099-01-01 00:00:00')", [request['id']])
            result = {'inserted': True}
        elif action == 'capture':
            assert len(request['records']) <= 10
            for record in request['records']:
                assert record['source_app'].startswith('QA ')
                assert len(record['content'].encode('utf-8')) <= 300000
                conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at,user_api_key) VALUES(?,?,?,?,?,?)", [record['id'],record['type'],record['content'],record['source_app'],'2099-01-01 00:00:00',int(record.get('user_api_key', False))])
            result = {'inserted': len(request['records'])}
        elif action in ('ttl_prepare', 'ttl_inspect', 'ttl_restore'):
            prefix, image_prefix = request['prefix'], request['imagePrefix']
            assert prefix.startswith('QA-cleanup-') and image_prefix.startswith('QA-images-')
            assert len(prefix) < 100 and len(image_prefix) < 100
            if action == 'ttl_prepare':
                eligible = conn.execute("SELECT COUNT(*) FROM clipboard_records r WHERE source_app NOT IN (?,?) AND is_favorite=0 AND user_api_key=0 AND content NOT LIKE 'dpapi:v1:%' AND NOT EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=r.id) AND datetime(created_at)<datetime('now','-7 days')", [prefix, image_prefix]).fetchone()[0]
                assert eligible == 0, 'Existing fixture records must not be collateral TTL candidates'
                settings = dict(conn.execute("SELECT key,value FROM settings WHERE key IN ('clipboard_retention','max_history_items','max_storage_mb')"))
                conn.execute("UPDATE settings SET value='100000' WHERE key='max_history_items'")
                conn.execute("UPDATE settings SET value='1024' WHERE key='max_storage_mb'")
                conn.execute("UPDATE settings SET value='1week' WHERE key='clipboard_retention'")
                conn.execute("UPDATE clipboard_records SET created_at='1970-01-01T00:00:00Z' WHERE source_app=?", [image_prefix])
                paths = [row[0] for row in conn.execute('SELECT content FROM clipboard_records WHERE source_app=? ORDER BY content', [image_prefix])]
                assert len(paths) == 12 and all(value.startswith('images/' + image_prefix + '-') for value in paths)
                conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at,is_favorite) VALUES(?,'image',?,?,'1970-01-01T00:00:00Z',1)", [str(uuid.uuid4()), paths[0], image_prefix])
                result = {'settings': settings, 'paths': paths, 'sharedProtectedPath': paths[0], 'normalText': 2000, 'normalImages': 12, 'protectedText': 60}
            elif action == 'ttl_restore':
                assert set(request['settings']) == {'clipboard_retention', 'max_history_items', 'max_storage_mb'}
                for key, value in request['settings'].items():
                    assert (key == 'clipboard_retention' and value in ('1week', '1month', '3months')) or (key != 'clipboard_retention' and str(value).isdigit())
                    conn.execute('UPDATE settings SET value=? WHERE key=?', [value, key])
                result = {'restored': True}
            else:
                rows = conn.execute('SELECT * FROM clipboard_records WHERE source_app NOT IN (?,?) ORDER BY id', [prefix,image_prefix]).fetchall()
                result = {'baselineClipboardHash': hashlib.sha256(json.dumps(rows,ensure_ascii=True).encode()).hexdigest(), 'groups': conn.execute('SELECT type,is_favorite,user_api_key,EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=r.id),COUNT(*) FROM clipboard_records r WHERE source_app IN (?,?) GROUP BY 1,2,3,4', [prefix,image_prefix]).fetchall(), 'foreignKeyViolations':len(conn.execute('PRAGMA foreign_key_check').fetchall()), 'integrity':conn.execute('PRAGMA integrity_check').fetchone()[0]}
        elif action in ('periodic_note_fault', 'periodic_note_unfault'):
            prefix = request['prefix']
            assert prefix.startswith('QA-periodic-') and str(uuid.UUID(prefix[12:])) == prefix[12:]
            if action == 'periodic_note_fault':
                conn.execute("CREATE TRIGGER qa_periodic_note_failure BEFORE DELETE ON notes WHEN OLD.title='" + prefix + "' BEGIN SELECT RAISE(ABORT,'QA periodic synthetic failure'); END")
                result = {'installed':True}
            else:
                conn.execute('DROP TRIGGER IF EXISTS qa_periodic_note_failure')
                result = {'removed':True}
        elif action in ('periodic_prepare', 'periodic_inspect', 'periodic_remove'):
            prefix = request['prefix']
            assert prefix.startswith('QA-periodic-') and len(prefix) < 100
            if action == 'periodic_prepare':
                external = Path(request['external']).resolve()
                assert external.is_relative_to(ROOT.resolve()) and external.name.startswith('QA-periodic-')
                settings = dict(conn.execute("SELECT key,value FROM settings WHERE key IN ('clipboard_retention','max_history_items','max_storage_mb')"))
                conn.execute("UPDATE settings SET value='100000' WHERE key='max_history_items'")
                conn.execute("UPDATE settings SET value='1024' WHERE key='max_storage_mb'")
                conn.execute("UPDATE settings SET value='1week' WHERE key='clipboard_retention'")
                for index in range(208):
                    identity, mutation = str(uuid.uuid4()), str(uuid.uuid4())
                    deleted = 1 if index < 205 else (4102444800000 if index == 207 else None)
                    archived = 1 if index == 206 else None
                    conn.execute("INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,archived_at_ms,deleted_at_ms,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash) VALUES(?,?,'QA periodic note','QA periodic note',16,16,1,1,1,?,?,?,?,?,?)", [identity,prefix,archived,deleted,mutation,'qa',mutation,'qa'])
                    conn.execute("INSERT INTO note_refs VALUES(?,?,'file',?,'QA external file',0)", [str(uuid.uuid4()),identity,str(external)])
                result = {'settings':settings,'expiredTrash':205,'active':1,'archived':1,'recentTrash':1}
            elif action == 'periodic_remove':
                result = {'removed':conn.execute('DELETE FROM notes WHERE title=?', [prefix]).rowcount}
            else:
                active_id = str(uuid.UUID(request['activeId']))
                hashes = {}
                queries = {
                    'notes': ('SELECT * FROM notes WHERE title<>? AND id<>? ORDER BY id', [prefix,active_id]),
                    'note_refs': ('SELECT * FROM note_refs WHERE note_id NOT IN (SELECT id FROM notes WHERE title=? OR id=?) ORDER BY id', [prefix,active_id]),
                    'note_import_origins': ('SELECT * FROM note_import_origins ORDER BY origin_key', []),
                    'vault_config': ('SELECT * FROM vault_config ORDER BY id', []),
                    'vault_entries': ('SELECT * FROM vault_entries ORDER BY id', [])}
                for table, (query, parameters) in queries.items():
                    if table == 'note_import_origins':
                        columns = [row[1] for row in conn.execute('PRAGMA table_info(note_import_origins)')]
                        query = 'SELECT * FROM note_import_origins ORDER BY ' + ','.join(columns)
                    hashes[table] = hashlib.sha256(json.dumps(conn.execute(query,parameters).fetchall(),ensure_ascii=True).encode()).hexdigest()
                groups = conn.execute('SELECT archived_at_ms IS NOT NULL,deleted_at_ms IS NOT NULL,deleted_at_ms=1,COUNT(*) FROM notes WHERE title=? GROUP BY 1,2,3', [prefix]).fetchall()
                result = {'noteGroups':groups,'businessHashes':hashes,'expiredClipboard':conn.execute("SELECT COUNT(*) FROM clipboard_records WHERE source_app=? AND is_favorite=0 AND user_api_key=0 AND NOT EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=clipboard_records.id)", [request['clipboardPrefix']]).fetchone()[0], 'protectedClipboard':conn.execute('SELECT COUNT(*) FROM clipboard_records WHERE source_app=? AND (is_favorite=1 OR user_api_key=1 OR EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=clipboard_records.id))', [request['clipboardPrefix']]).fetchone()[0], 'integrity':conn.execute('PRAGMA integrity_check').fetchone()[0], 'foreignKeyViolations':len(conn.execute('PRAGMA foreign_key_check').fetchall())}
        elif action == 'cleanup_load':
            prefix = request['prefix']
            assert prefix.startswith('QA-cleanup-') and len(prefix) < 100
            baseline = conn.execute('SELECT id FROM clipboard_records ORDER BY id').fetchall()
            settings = dict(conn.execute("SELECT key,value FROM settings WHERE key IN ('max_history_items','max_storage_mb')"))
            assert set(settings) == {'max_history_items', 'max_storage_mb'}
            assert not conn.execute('SELECT 1 FROM clipboard_records WHERE source_app=?', [prefix]).fetchone()
            for index in range(2060):
                identity = str(uuid.uuid4())
                favorite, manual, label = 2000 <= index < 2020, 2020 <= index < 2040, index >= 2040
                conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at,is_favorite,user_api_key) VALUES(?,'text',?,?,'1970-01-01 00:00:00',?,?)", [identity,prefix+' '+str(index)+' '+('中文 raw body ' * 300),prefix,int(favorite),int(manual)])
                if label:
                    conn.execute("INSERT INTO api_key_labels(record_id,key_preview,service,created_at,updated_at) VALUES(?,?,'QA synthetic','1970-01-01','1970-01-01')", [identity,prefix+' label '+str(index)])
            limit = len(baseline) + 500
            conn.execute("UPDATE settings SET value=? WHERE key='max_history_items'", [str(limit)])
            conn.execute("UPDATE settings SET value='1024' WHERE key='max_storage_mb'")
            result = {'baselineIdsHash':hashlib.sha256(json.dumps(baseline).encode()).hexdigest(),'baselineCount':len(baseline),'settings':settings,'normal':2000,'favorites':20,'manualKeys':20,'labelKeys':20,'maxItems':limit}
        elif action == 'cleanup_inspect':
            prefix = request['prefix']
            assert prefix.startswith('QA-cleanup-') and len(prefix) < 100
            groups = conn.execute("SELECT is_favorite,user_api_key,EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=r.id),COUNT(*) FROM clipboard_records r WHERE source_app=? GROUP BY 1,2,3", [prefix]).fetchall()
            sentinel = request['sentinel']
            assert sentinel.startswith('QA controlled clipboard cleanup ')
            baseline = conn.execute('SELECT id FROM clipboard_records WHERE source_app<>? AND content<>? ORDER BY id', [prefix,sentinel]).fetchall()
            result = {'groups':groups,'baselineIdsHash':hashlib.sha256(json.dumps(baseline).encode()).hexdigest(),'records':conn.execute('SELECT COUNT(*) FROM clipboard_records').fetchone()[0],'usage':conn.execute('SELECT * FROM clipboard_usage').fetchall(),'integrity':conn.execute('PRAGMA integrity_check').fetchone()[0]}
        elif action == 'remove_cleanup_load':
            prefix = request['prefix']
            assert prefix.startswith('QA-cleanup-') and len(prefix) < 100
            assert set(request['settings']) == {'max_history_items','max_storage_mb'}
            for key,value in request['settings'].items():
                assert str(value).isdigit()
                conn.execute('UPDATE settings SET value=? WHERE key=?', [value,key])
            conn.execute('DELETE FROM api_key_labels WHERE record_id IN (SELECT id FROM clipboard_records WHERE source_app=?)', [prefix])
            result = {'removed':conn.execute('DELETE FROM clipboard_records WHERE source_app=?', [prefix]).rowcount}
            sentinel = request['sentinel']
            assert sentinel.startswith('QA controlled clipboard cleanup ')
            conn.execute('DELETE FROM clipboard_records WHERE content=?', [sentinel])
            result['integrity'] = conn.execute('PRAGMA integrity_check').fetchone()[0]
        elif action == 'backup_load':
            prefix = request['prefix']
            assert prefix.startswith('QA-backup-load-') and len(prefix) < 100
            target = int(request['targetBytes'])
            assert 70 * 1024 * 1024 <= target <= 80 * 1024 * 1024
            existing = conn.execute('SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM notes WHERE deleted_at_ms IS NULL').fetchone()[0]
            remaining = max(0, target - existing)
            ids = []
            while remaining:
                size = min(remaining, 262144)
                body = 'x' * size
                identity = str(uuid.uuid4())
                mutation = str(uuid.uuid4())
                digest = hashlib.sha256(body.encode()).hexdigest()
                conn.execute('INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash) VALUES(?,?,?,?,?,?,1,1,1,?,?,?,?)', [identity,prefix,body,'x' * min(size,160),size,size,mutation,digest,mutation,digest])
                ids.append(identity)
                remaining -= size
            result = {'ids': ids, 'beforeRawBytes': existing, 'afterRawBytes': max(existing,target)}
        elif action == 'scale_load':
            prefix = request['prefix']
            count = int(request['count'])
            assert prefix.startswith('QA-scale-') and len(prefix) < 100 and count in (10000, 50000)
            conn.execute('PRAGMA foreign_keys=ON')
            assert not conn.execute('SELECT 1 FROM notes WHERE substr(title,1,?)=?', [len(prefix),prefix]).fetchone()
            base = ('中文 Mixed ABC 0123456789\nhttps://example.com/\n' * 100).encode('utf-8')[:4000].decode('utf-8',errors='ignore')
            body = base + '\n' + prefix + '-body-only'
            digest = hashlib.sha256(body.encode()).hexdigest()
            first_id = None
            for index in range(count):
                identity = str(uuid.uuid4())
                mutation = str(uuid.uuid4())
                if first_id is None:
                    first_id = identity
                conn.execute('INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)', [identity,prefix+' '+str(index),body,body[:160],len(body),len(body.encode()),1600000000000+index,1600000000000+index,mutation,digest,mutation,digest])
            for index in range(2000):
                conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at,is_favorite) VALUES(?,'text',?,?,'2099-01-01 00:00:00',1)", [str(uuid.uuid4()),prefix+' '+str(index)+'\n'+base,prefix])
            result = {'firstId':first_id,'notes':count,'clipboardRecords':2000,'bodyBytes':len(body.encode()),'noteRawBytes':count*len(body.encode()),'clipboardProtectedFromBackgroundEviction':True}
        elif action == 'remove_scale_load':
            prefix = request['prefix']
            assert prefix.startswith('QA-scale-') and len(prefix) < 100
            conn.execute('PRAGMA foreign_keys=ON')
            result = {'notesRemoved':conn.execute('DELETE FROM notes WHERE substr(title,1,?)=?', [len(prefix),prefix]).rowcount,'clipboardRemoved':conn.execute('DELETE FROM clipboard_records WHERE source_app=?', [prefix]).rowcount}
            result['integrity'] = conn.execute('PRAGMA integrity_check').fetchone()[0]
        elif action in ('query_load', 'query_append', 'remove_query_load'):
            prefix = request['prefix']
            assert prefix.startswith('QA-query-') and len(prefix) < 100
            if action == 'remove_query_load':
                result = {'removed': conn.execute('DELETE FROM clipboard_records WHERE source_app=?', [prefix]).rowcount,
                          'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0],
                          'foreignKeyViolations': len(conn.execute('PRAGMA foreign_key_check').fetchall())}
            else:
                count = 1 if action == 'query_append' else 260
                if action == 'query_load':
                    assert not conn.execute('SELECT 1 FROM clipboard_records WHERE source_app=?', [prefix]).fetchone()
                else:
                    assert conn.execute('SELECT COUNT(*) FROM clipboard_records WHERE source_app=?', [prefix]).fetchone()[0] == 260
                ids = [str(uuid.uuid4()) for _ in range(count)]
                for index, identity in enumerate(ids):
                    conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at) VALUES(?,'text',?,?,?)",
                                 [identity, prefix+' common token '+str(index), prefix,
                                  '2100-01-01T00:00:00Z' if action == 'query_append' else '2099-01-01T00:00:00Z'])
                result = {'ids': ids, 'count': count}
        elif action == 'image_load':
            prefix = request['prefix']
            count = int(request.get('count', 150))
            assert prefix.startswith('QA-images-') and len(prefix) < 100 and 1 <= count <= 200
            image_root = database.parent / 'images'
            image_root.mkdir(exist_ok=True)
            def chunk(kind, data):
                return struct.pack('>I',len(data)) + kind + data + struct.pack('>I',zlib.crc32(kind+data))
            ids = []
            total = 0
            for index in range(count):
                seed = request.get('seed', prefix)
                assert seed.startswith('QA-') and len(seed) < 100
                generator = random.Random(seed + str(index))
                tile = [b'\0' + generator.randbytes(1024 * 3) for _ in range(8)]
                raw = b''.join(tile[row % 8] for row in range(768))
                png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',1024,768,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(raw,3)) + chunk(b'IEND',b'')
                identity = str(uuid.uuid4())
                relative = 'images/' + prefix + '-' + str(index) + '.png'
                with (database.parent / relative).open('xb') as file:
                    file.write(png)
                conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at) VALUES(?,'image',?,?,'2099-01-01 00:00:00')", [identity,relative,prefix])
                conn.execute('UPDATE clipboard_assets SET byte_size=? WHERE path=?', [len(png),relative])
                total += len(png)
                ids.append(identity)
            result = {'ids': ids, 'imageCount': count, 'encodedBytes': total, 'width':1024, 'height':768}
        elif action == 'list_qa_image_groups':
            result = {'groups': conn.execute("SELECT source_app,COUNT(*) FROM clipboard_records WHERE source_app LIKE 'QA-images-%' AND type='image' GROUP BY source_app").fetchall()}
        elif action in ('remove_image_load', 'remove_rich_images'):
            prefix = request['prefix']
            assert prefix.startswith('QA-images-') and len(prefix) < 100
            paths = conn.execute('SELECT content FROM clipboard_records WHERE source_app=? AND type=?', [prefix,'image']).fetchall()
            for (relative,) in paths:
                assert Path(relative).name == relative[7:] and relative.startswith('images/')
                if not relative.startswith('images/' + prefix + '-'):
                    assert action == 'remove_rich_images' and Path(relative).suffix in ('.png', '.jpg') and Path(relative).stem.startswith('import-')
                    uuid.UUID(Path(relative).stem[7:])
            removed = conn.execute('DELETE FROM clipboard_records WHERE source_app=? AND type=?', [prefix,'image']).rowcount
            for (relative,) in paths:
                if conn.execute('SELECT 1 FROM clipboard_records WHERE content=? LIMIT 1', [relative]).fetchone():
                    continue
                for file in (database.parent / relative, database.parent / 'images' / 'thumbs' / Path(relative).name):
                    file.unlink(missing_ok=True)
                conn.execute('DELETE FROM clipboard_assets WHERE path=? AND ref_count=0', [relative])
            result = {'removed': removed}
        elif action == 'remove_backup_load':
            prefix = request['prefix']
            assert prefix.startswith('QA-backup-load-') and len(prefix) < 100
            result = {'removed': conn.execute('DELETE FROM notes WHERE title=?', [prefix]).rowcount}
        elif action == 'remove_crash_note':
            identity = str(uuid.UUID(request['id']))
            row = conn.execute('SELECT title,deleted_at_ms FROM notes WHERE id=?', [identity]).fetchone()
            assert row and row[0] == 'QA acknowledged crash ' + identity and row[1] is not None
            result = {'removed': conn.execute('DELETE FROM notes WHERE id=?', [identity]).rowcount}
        elif action == 'remove_memory_note':
            identity = str(uuid.UUID(request['id']))
            row = conn.execute('SELECT title,deleted_at_ms FROM notes WHERE id=?', [identity]).fetchone()
            assert row and row[0] == 'QA memory target ' + identity and row[1] is not None
            result = {'removed': conn.execute('DELETE FROM notes WHERE id=?', [identity]).rowcount}
        elif action == 'remove_metrics_notes':
            prefix = request['prefix']
            assert prefix.startswith('QA rich backup ') and len(prefix) < 100
            result = {'removed': conn.execute('DELETE FROM notes WHERE substr(title,1,?)=?', [len(prefix), prefix]).rowcount}
        elif action == 'delete_history':
            for record_id in request['ids']:
                assert conn.execute('SELECT source_app FROM clipboard_records WHERE id=?', [record_id]).fetchone()[0].startswith('QA ')
                conn.execute('DELETE FROM clipboard_records WHERE id=?', [record_id])
            result = {'deleted': len(request['ids'])}
        elif action == 'legacy_protection_status':
            setting = conn.execute("SELECT value FROM settings WHERE key='ai_api_key'").fetchone()[0]
            vault_rows = conn.execute('SELECT * FROM vault_entries ORDER BY id').fetchall() + conn.execute('SELECT * FROM vault_config').fetchall()
            record = conn.execute('SELECT content,user_api_key FROM clipboard_records WHERE id=?', [request.get('recordId', '')]).fetchone()
            result = {'settingProtected': setting.startswith('dpapi:v1:'), 'settingHash': hashlib.sha256(setting.encode()).hexdigest(), 'vaultHash': hashlib.sha256(json.dumps(vault_rows, ensure_ascii=True).encode()).hexdigest(), 'recordProtected': bool(record and record[0].startswith('dpapi:v1:') and record[1])}
        elif action == 'rich_backup_fault':
            prefix = request['prefix']
            assert prefix.startswith('QA rich backup ') and len(prefix) < 100
            conn.execute("CREATE TRIGGER qa_rich_backup_failure BEFORE INSERT ON notes WHEN substr(NEW.title,1,%d)=%s BEGIN SELECT RAISE(ABORT,'QA injected rich backup failure'); END" % (len(prefix), "'" + prefix.replace("'", "''") + "'"))
            result = {'installed': True}
        elif action == 'rich_backup_unfault':
            conn.execute('DROP TRIGGER IF EXISTS qa_rich_backup_failure')
            result = {'removed': True}
        elif action == 'rich_backup_inspect':
            tables = ['settings', 'clipboard_records', 'api_key_labels', 'vault_config', 'vault_entries', 'notes', 'note_refs', 'note_import_origins', 'clipboard_assets', 'clipboard_usage', 'notes_search_ids', 'note_refs_search_ids']
            digests = {}
            for table in tables:
                rows = conn.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall()
                digests[table] = hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
            image_root = database.parent / 'images'
            files = sorted(str(file.relative_to(image_root)) for file in image_root.rglob('*') if file.is_file()) if image_root.exists() else []
            result = {'tableHashes': digests, 'imageFiles': files, 'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0]}
        elif action == 'inspect_joint':
            row = conn.execute('SELECT body,revision,title FROM notes WHERE id=?', [request['id']]).fetchone()
            assert row and row[2].startswith('QA lifecycle joint ')
            result = {'body': row[0], 'revision': row[1], 'model': conn.execute("SELECT value FROM settings WHERE key='ai_model'").fetchone()[0], 'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0]}
        elif action == 'inspect':
            result = {
                'settings': dict(conn.execute("SELECT key,value FROM settings WHERE key IN ('storage_path','qa_existing_target','internal_storage_migration_receipt_v1')")),
                'notes': [dict(zip(('id','body','revision','creation_mutation_id','creation_hash','archived_at_ms','deleted_at_ms'), row)) for row in conn.execute('SELECT id,body,revision,creation_mutation_id,creation_hash,archived_at_ms,deleted_at_ms FROM notes WHERE id IN (' + ','.join('?' for _ in request['ids']) + ')', request['ids'])],
                'historyExists': bool(conn.execute('SELECT 1 FROM clipboard_records WHERE id=?', [request['historyId']]).fetchone()),
                'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0],
            }
        else:
            raise ValueError('Unknown QA action')
print(json.dumps(result, ensure_ascii=True))
