"""Exercise old/new schema admission using only owned temporary QA databases."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid

root = Path(__file__).resolve().parents[1] / 'output/optimization/baseline-runtime-20261008'
fixture = root / ('guard-fixture-' + str(uuid.uuid4()))
app = fixture / 'com.copycreator.qabaseline20261008v2'
app.mkdir(parents=True)
database = app / 'data.db'
results = []
try:
    for variant, version, expected in [('R0', 0, True), ('R1', 0, True), ('current', 5, True), ('R0', 5, False), ('R1', 5, False), ('current', 6, False)]:
        with closing(sqlite3.connect(database)) as conn:
            conn.execute('PRAGMA user_version=' + str(version))
        process = subprocess.run([sys.executable, str(Path(__file__).with_name('qa-runtime-baseline-guard.py'))], input=json.dumps({'action': 'build', 'variant': variant}), text=True, capture_output=True, env={**os.environ, 'APPDATA': str(fixture)})
        assert (process.returncode == 0) == expected
        results.append({'variant': variant, 'schema': version, 'accepted': process.returncode == 0, 'expected': expected})
finally:
    assert fixture.resolve().is_relative_to(root.resolve()) and fixture.name.startswith('guard-fixture-')
    for file in app.iterdir():
        assert file.is_file()
        file.unlink()
    app.rmdir()
    fixture.rmdir()
report = {'passed': True, 'cases': results, 'fixtureRemoved': True, 'scope': 'Genuine frozen build hashes; synthetic schema database only, no app launch'}
(root / 'reports/schema-admission-v2.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
