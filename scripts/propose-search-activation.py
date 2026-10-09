"""Write a reviewable default-activation patch; do not apply it."""
from pathlib import Path
import difflib
import json

REPO=Path(__file__).resolve().parents[1]
APP=REPO/'copy-creator'
QA=REPO/'output/optimization/QA-notes-20261007/search-runtime-qa'
changes={}
def change(relative,old,new):
    before=(APP/relative).read_text(encoding='utf-8')
    current=changes.get(relative,(before,before))[1]
    assert current.count(old)==1,(relative,old[:90])
    changes[relative]=(before,current.replace(old,new))

change('src-tauri/src/lib.rs','#[cfg(test)]\nmod note_search;','mod note_search;')
change('src-tauri/src/db.rs','if version > 4 {','if version > 5 {')
change('src-tauri/src/db.rs','    migrate_secrets(conn)?;\n    Ok(())','''    if version < 5 {
        let tx = conn.transaction()?;
        crate::note_search::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=5;")?;
        tx.commit()?;
    }
    migrate_secrets(conn)?;
    Ok(())''')
old='assert_eq!(conn.query_row("PRAGMA user_version",[],|r| r.get::<_,i64>(0)).unwrap(),4);'
change('src-tauri/src/db.rs',old,old[:-3]+'5);')
change('src-tauri/src/notes.rs','    let (condition, sort) = match filter {','''    let candidates = if search.is_empty() { None } else {
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
change('src-tauri/src/notes.rs','FROM notes n WHERE {condition}\n        AND','FROM notes n WHERE {condition} {candidate_filter}\n        AND')
change('src-tauri/src/notes.rs','                (limit + 1) as i64\n','                (limit + 1) as i64,\n                candidate_json\n')
patch=''.join(''.join(difflib.unified_diff(before.splitlines(keepends=True),after.splitlines(keepends=True),fromfile='a/copy-creator/'+relative,tofile='b/copy-creator/'+relative)) for relative,(before,after) in changes.items())
(QA/'default-activation-proposal.diff').write_text(patch,encoding='utf-8')
(QA/'default-activation-proposal.json').write_text(json.dumps({'applied':False,'files':list(changes),'indexImplementation':'copy-creator/src-tauri/src/note_search.rs','scope':'Proposal only. Enable derived indexes for ordinary notes/refs; schema 4→5 transaction; preserve final literal LIKE and bounded candidate fallback. No QA storage overrides or disabled features enter default app.'},indent=2),encoding='utf-8')
print(json.dumps({'applied':False,'proposal':str(QA/'default-activation-proposal.diff')}))
