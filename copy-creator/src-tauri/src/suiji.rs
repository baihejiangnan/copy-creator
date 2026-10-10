//! Organization belongs to records, independently of their autosaved content.
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS note_organization(
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        group_id TEXT, starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN(0,1)));
        CREATE INDEX IF NOT EXISTS idx_note_organization_group ON note_organization(group_id,note_id);
        CREATE TABLE IF NOT EXISTS note_group_colors(id TEXT PRIMARY KEY, color TEXT NOT NULL);")
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoteGroup {
    pub id: String, pub name: String, pub color: String, pub sort_order: i64,
    #[serde(default, skip_serializing)] pub count: i64,
}
pub(crate) fn groups(conn: &Connection) -> rusqlite::Result<Vec<NoteGroup>> {
    conn.prepare("SELECT g.id,g.name,COALESCE(c.color,'#8e8e93'),g.sort_order,
        (SELECT COUNT(*) FROM note_organization o JOIN notes n ON n.id=o.note_id
         WHERE o.group_id=g.id AND n.deleted_at_ms IS NULL AND n.archived_at_ms IS NULL)
        FROM phrase_groups g LEFT JOIN note_group_colors c ON c.id=g.id ORDER BY g.sort_order,g.created_at,g.id")?
        .query_map([],|r|Ok(NoteGroup{id:r.get(0)?,name:r.get(1)?,color:r.get(2)?,sort_order:r.get(3)?,count:r.get(4)?}))?.collect()
}
pub(crate) fn restore_groups(conn: &Connection, groups: &[NoteGroup]) -> Result<(),String> {
    validate_groups(groups)?;
    for g in groups {
        let now=chrono::Utc::now().to_rfc3339();
        let inserted=conn.execute("INSERT OR IGNORE INTO phrase_groups(id,name,sort_order,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![g.id,g.name,g.sort_order,now]).map_err(|_|"backup.databaseFailed")?;
        if inserted>0 { conn.execute("INSERT OR IGNORE INTO note_group_colors VALUES(?1,?2)",params![g.id,g.color]).map_err(|_|"backup.databaseFailed")?; }
    }
    Ok(())
}
pub(crate) fn validate_groups(groups: &[NoteGroup]) -> Result<(),String> {
    let mut ids=std::collections::HashSet::new();
    if groups.len()>10_000 { return Err("backup.invalidFile".into()); }
    for g in groups {
        if uuid::Uuid::parse_str(&g.id).is_err() || !ids.insert(&g.id) || g.name.trim().is_empty() || g.name.len()>4096 || !valid_color(&g.color) { return Err("backup.invalidFile".into()); }
    }
    Ok(())
}
fn valid_color(color: &str)->bool { color.len()==7 && color.starts_with('#') && color[1..].bytes().all(|b|b.is_ascii_hexdigit()) }

#[tauri::command]
pub fn get_suiji_groups(app:AppHandle,expected_storage_epoch:u64)->Result<crate::notes::StorageResult<Vec<serde_json::Value>>,String> {
    let lifecycle=app.state::<crate::lifecycle::LifecycleState>();
    let _producer=lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app,Some(expected_storage_epoch))?;
    let state=app.state::<crate::db::DbState>(); let conn=state.conn.lock().map_err(|_|"notes.databaseFailed")?;
    // IPC rows include counts; portable backup rows deliberately omit them.
    let rows=groups(&conn).map_err(|_|"notes.databaseFailed")?.into_iter().map(|g|serde_json::json!({"id":g.id,"name":g.name,"color":g.color,"sort_order":g.sort_order,"count":g.count})).collect();
    Ok(crate::notes::StorageResult{storage_epoch:expected_storage_epoch,value:rows})
}
#[tauri::command]
pub fn save_suiji_group(app:AppHandle,expected_storage_epoch:u64,id:Option<String>,name:String,color:String,direction:Option<i32>)->Result<(),String> {
    let lifecycle=app.state::<crate::lifecycle::LifecycleState>(); let _producer=lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app,Some(expected_storage_epoch))?;
    if name.trim().is_empty() || name.chars().count()>128 || !valid_color(&color) {return Err("notes.invalidGroup".into());}
    let state=app.state::<crate::db::DbState>(); let mut conn=state.conn.lock().map_err(|_|"notes.databaseFailed")?;
    let tx=conn.transaction().map_err(|_|"notes.databaseFailed")?;
    let id=id.unwrap_or_else(||uuid::Uuid::new_v4().to_string()); let now=chrono::Utc::now().to_rfc3339();
    if uuid::Uuid::parse_str(&id).is_err() {return Err("notes.invalidGroup".into());}
    let (count,exists):(i64,bool)=tx.query_row("SELECT COUNT(*),EXISTS(SELECT 1 FROM phrase_groups WHERE id=?1) FROM phrase_groups",[&id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"notes.databaseFailed")?;
    if count>=10_000 && !exists {return Err("notes.invalidGroup".into());}
    tx.execute("INSERT INTO phrase_groups(id,name,sort_order,created_at,updated_at) VALUES(?1,?2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM phrase_groups),?3,?3)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",params![id,name.trim(),now]).map_err(|_|"notes.databaseFailed")?;
    tx.execute("INSERT INTO note_group_colors VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET color=excluded.color",params![id,color]).map_err(|_|"notes.databaseFailed")?;
    if let Some(direction)=direction {
        let mut ordered=groups(&tx).map_err(|_|"notes.databaseFailed")?;
        if let Some(index)=ordered.iter().position(|g|g.id==id) {
            let target=(index as i64+i64::from(direction.signum())).clamp(0,ordered.len() as i64-1) as usize;
            ordered.swap(index,target);
            for (index,g) in ordered.iter().enumerate() { tx.execute("UPDATE phrase_groups SET sort_order=?2 WHERE id=?1",params![g.id,index as i64]).map_err(|_|"notes.databaseFailed")?; }
        }
    }
    tx.commit().map_err(|_|"notes.databaseFailed")?; let _=crate::storage_events::emit(&app,"phrase-groups-changed",()); Ok(())
}

pub(crate) fn delete_group(conn: &Connection, id: &str) -> Result<(),String> {
    conn.execute("UPDATE notes SET revision=revision+1,updated_at_ms=?2,last_mutation_id='',last_mutation_hash='' WHERE id IN(SELECT note_id FROM note_organization WHERE group_id=?1)", params![id,chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    conn.execute("UPDATE note_organization SET group_id=NULL WHERE group_id=?1", [&id]).map_err(|e|e.to_string())?;
    conn.execute("DELETE FROM note_group_colors WHERE id=?1",[&id]).map_err(|e|e.to_string())?;
    conn.execute("DELETE FROM phrase_groups WHERE id=?1",[&id]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_a_group_keeps_body_and_common_state_and_invalidates_stale_revisions() {
        let mut conn=Connection::open_in_memory().unwrap();crate::db::initialize_connection(&mut conn).unwrap();
        let group=uuid::Uuid::new_v4().to_string(); let id=uuid::Uuid::new_v4().to_string();
        restore_groups(&conn,&[NoteGroup{id:group.clone(),name:"group".into(),color:"#aabbcc".into(),sort_order:0,count:0}]).unwrap();
        conn.execute("INSERT INTO notes VALUES(?1,'title','raw  ','raw',5,5,1,2,3,NULL,NULL,NULL,?1,'create',?1,'save')",[&id]).unwrap();
        conn.execute("INSERT INTO note_organization VALUES(?1,?2,1)",params![id,group]).unwrap();
        {let tx=conn.transaction().unwrap();delete_group(&tx,&group).unwrap();tx.commit().unwrap();}
        let note=crate::notes::read_note(&conn,&id).unwrap();assert_eq!(note.body,"raw  ");assert_eq!(note.summary.revision,4);assert!(note.summary.starred);assert!(note.summary.group_id.is_none());
        assert!(groups(&conn).unwrap().is_empty());
    }
}
