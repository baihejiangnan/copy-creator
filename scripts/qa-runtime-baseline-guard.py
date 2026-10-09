"""Read-only admission for rebuilt, system-isolated generation-2 baselines."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from contextlib import closing

root = Path(__file__).resolve().parents[1] / 'output/optimization/baseline-runtime-20261008'
identifier = 'com.copycreator.qabaseline20261008v2'
request = json.load(sys.stdin)
assert request['action'] in ('build', 'selected')
if request['action'] == 'selected':
    assert Path(request['metadata']).resolve() == (root / 'process.json').resolve()
    info = json.loads((root / 'process.json').read_text(encoding='utf-8-sig'))
    variant = info['variant']
else:
    variant = request['variant']
assert variant in ('R0', 'R1', 'current')
artifact = root / (variant + '-embedded-v2')
build = json.loads((artifact / 'build.json').read_text(encoding='utf-8-sig'))
assert build['identifier'] == identifier and build['generation'] == 2
assert build['variant'] == variant and build['profile'] == 'release-default'
assert build['autostartIsolation'] == build['pasteIsolation'] == 'identifier'
assert build['schemaMax'] == (5 if variant == 'current' else 0)
binary = artifact / 'copy-creator.exe'
assert binary.stat().st_size == build['bytes'] >= (70000000 if variant == 'R0' else 40000000)
assert hashlib.sha256(binary.read_bytes()).hexdigest().upper() == build['sha256'].upper()
storage = Path(os.environ['APPDATA']) / identifier
if request['action'] == 'selected':
    assert info['identifier'] == identifier and info['generation'] == 2
    assert info['profile'] == 'release-default' and info['schemaMax'] == build['schemaMax']
    assert info['autostartIsolation'] == info['pasteIsolation'] == 'identifier'
    assert Path(info['storageRoot']).resolve() == storage.resolve()
    assert Path(info['exe']).resolve() == (root / 'copy-creator-qa.exe').resolve()
    assert info['sha256'].upper() == build['sha256'].upper()
    assert hashlib.sha256(Path(info['exe']).read_bytes()).hexdigest().upper() == build['sha256'].upper()
database = storage / 'data.db'
schema = None
if database.exists():
    # Never let a historical executable interpret an upgraded database.
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        schema = conn.execute('PRAGMA user_version').fetchone()[0]
    assert 0 <= schema <= build['schemaMax'], 'Refusing older baseline against upgraded schema'
print(json.dumps({'verified': True, 'schema': schema, 'build': build}))
