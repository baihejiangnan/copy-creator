"""Copy frozen QA build sources and add test-only regression assertions."""
from pathlib import Path
import hashlib
import json
import shutil

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'output/optimization/QA-notes-20261007/search-runtime-qa'
SOURCE = ROOT / 'source'
TARGET = ROOT / 'test-source'
assert not TARGET.exists(), 'Refusing to replace test evidence'
shutil.copytree(SOURCE, TARGET)
db = TARGET / 'src-tauri/src/db.rs'
text = db.read_text(encoding='utf-8')
old = 'assert_eq!(conn.query_row("PRAGMA user_version",[],|r| r.get::<_,i64>(0)).unwrap(),4);'
assert text.count(old) == 1
db.write_text(text.replace(old, old[:-3]+'5);'), encoding='utf-8')
lib = TARGET / 'src-tauri/src/lib.rs'
lib.write_text(lib.read_text(encoding='utf-8')+'\n#[cfg(test)]\nmod qa_search_regression;\n', encoding='utf-8')
shutil.copy2(REPO / 'scripts/qa-search-regression.rs', TARGET / 'src-tauri/src/qa_search_regression.rs')
# The extra rowid assertion is test-only; runtime implementation is unchanged.
shutil.copy2(REPO / 'copy-creator/src-tauri/src/note_search.rs', TARGET / 'src-tauri/src/note_search.rs')
hashes = [{'path': str(p.relative_to(TARGET)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
          for p in TARGET.rglob('*') if p.is_file()]
(ROOT / 'test-source-hashes.json').write_text(json.dumps(hashes, indent=2),encoding='utf-8')
print(json.dumps({'testSource':str(TARGET),'files':len(hashes),'scope':'Only test declarations, schema assertion 4→5 and cfg(test) rowid regression differ from frozen QA build source.'}))
