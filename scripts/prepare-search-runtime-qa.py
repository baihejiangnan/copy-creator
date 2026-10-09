"""Prepare a guarded, synthetic-only search experiment; never edit app sources."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[1]
APP = REPO / 'copy-creator'
QA = REPO / 'output/optimization/QA-notes-20261007'
EXPERIMENT = QA / 'search-runtime-qa'
SOURCE = EXPERIMENT / 'source'
IDENTIFIER = 'com.copycreator.qa20261007search'
assert not EXPERIMENT.exists(), 'Refusing to overwrite a preserved experiment'
SOURCE.mkdir(parents=True)
files = subprocess.check_output(['rg', '--files', 'src-tauri', 'package.json'], cwd=APP, text=True).splitlines()
for relative in files:
    target = SOURCE / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(APP / relative, target)

def replace(relative, old, new):
    target = SOURCE / relative
    text = target.read_text(encoding='utf-8')
    assert text.count(old) == 1, (relative, old[:90], text.count(old))
    target.write_text(text.replace(old, new), encoding='utf-8')

lib = 'src-tauri/src/lib.rs'
replace(lib, '#[cfg(test)]\nmod note_search;', 'mod note_search;')
replace(lib, '        .setup(|app| {', '''        .setup(|app| {
            // Experimental binary cannot initialize a production app identity.
            if app.config().identifier != "com.copycreator.qa20261007search" {
                return Err("QA search identifier required".into());
            }''')
replace(lib, '''            let autostart = app.autolaunch();
            if autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }''', '            // QA: no host autostart registry changes.')
replace(lib, '            clipboard::start_monitor(app.handle())?;', '            // QA: no operating system clipboard reads or writes.')
replace(lib, '            shortcut::install_mouse_hook(app.handle());', '            // QA: no global mouse hook.')
start = (SOURCE / lib).read_text(encoding='utf-8')
old = start[start.index('            if let Ok(key) = db::get_setting'):start.index('            // Show main window')]
replace(lib, old, '            // QA: no global keyboard registration.\n\n')

db = 'src-tauri/src/db.rs'
text = (SOURCE / db).read_text(encoding='utf-8')
old = text[text.index('fn db_path(app: &AppHandle) -> PathBuf {'):text.index('\npub fn get_storage_dir')]
storage = EXPERIMENT / 'storage'
storage.mkdir()
replace(db, old, '''fn db_path(app: &AppHandle) -> PathBuf {
    assert_eq!(app.config().identifier, "com.copycreator.qa20261007search");
    // Fixed synthetic path; cannot follow any existing application's routing DB.
    PathBuf::from(r#"''' + str(storage / 'data.db') + '''"#)
}
''')
replace(db, 'if version > 4 {', 'if version > 5 {')
replace(db, '    migrate_secrets(conn)?;\n    Ok(())', '''    if version < 5 {
        let tx = conn.transaction()?;
        crate::note_search::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=5;")?;
        tx.commit()?;
    }
    migrate_secrets(conn)?;
    Ok(())''')

notes = 'src-tauri/src/notes.rs'
replace(notes, '    let (condition, sort) = match filter {', '''    let candidates = if search.is_empty() { None } else {
        crate::note_search::candidates(conn, search).map_err(database_error)?
    };
    if matches!(&candidates, Some(ids) if ids.is_empty()) {
        return Ok(NotePage { records: Vec::new(), next_cursor: None });
    }
    let candidate_filter = if candidates.is_some() {
        "AND n.rowid IN (SELECT value FROM json_each(?7))"
    } else { "AND ?7 IS NULL" };
    let candidate_json = candidates.map(|ids| serde_json::to_string(&ids).unwrap());
    let (condition, sort) = match filter {''')
replace(notes, 'FROM notes n WHERE {condition}\n        AND', 'FROM notes n WHERE {condition} {candidate_filter}\n        AND')
replace(notes, '                (limit + 1) as i64\n', '                (limit + 1) as i64,\n                candidate_json\n')

# Preserve the exact source and config of this QA-only experiment.
config = {'identifier': IDENTIFIER, 'productName': 'Copy Creator QA Search',
          'build': {'frontendDist': '../../../frontend-native-visibility', 'beforeBuildCommand': ''}}
(EXPERIMENT / 'tauri-qa.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
hashes = [{'path': str(p.relative_to(SOURCE)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
          for p in SOURCE.rglob('*') if p.is_file()]
(EXPERIMENT / 'source-hashes.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
(EXPERIMENT / 'experiment.json').write_text(json.dumps({
    'identifier': IDENTIFIER, 'storageRoot': str(storage), 'debugPort': 9236,
    'scope': 'Isolated source copy and fixed synthetic storage only. Default app remains schema 4. OS clipboard monitor, global hooks and autostart repair disabled.'
}, indent=2), encoding='utf-8')
print(json.dumps({'source': str(SOURCE), 'storage': str(storage), 'files': len(hashes)}))
