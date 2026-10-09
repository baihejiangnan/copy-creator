use crate::{db::DbState, notes::{NoteDraft, NoteRef, StorageResult}};
use std::sync::{Arc,OnceLock,atomic::Ordering};
use tauri::{AppHandle,Manager};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os="windows")]
fn reveal_path(path: &std::path::Path, is_directory: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::{w, PCWSTR}, Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::{Shell::{Common::ITEMIDLIST, SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteW},
            WindowsAndMessaging::SW_SHOWNORMAL},
    }};
    struct ComScope(bool);
    impl Drop for ComScope { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize(); } } } }
    struct ItemId(*mut ITEMIDLIST);
    impl Drop for ItemId { fn drop(&mut self) { if !self.0.is_null() { unsafe { CoTaskMemFree(Some(self.0.cast())); } } } }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // An existing COM apartment remains owned by its initializer. Every
        // successful call (including S_FALSE) gets exactly one uninitialize.
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE { return Err("notes.fileOpenFailed".into()); }
        let _com = ComScope(initialized.is_ok());
        if is_directory {
            let result=ShellExecuteW(None,w!("open"),PCWSTR(wide.as_ptr()),None,None,SW_SHOWNORMAL);
            if result.0 as isize <= 32 { return Err("notes.fileOpenFailed".into()); }
        } else {
            let mut item=ItemId(std::ptr::null_mut());
            SHParseDisplayName(PCWSTR(wide.as_ptr()),None,&mut item.0,0,None).map_err(|_|"notes.fileOpenFailed")?;
            if item.0.is_null() { return Err("notes.fileOpenFailed".into()); }
            // With no child array, Windows opens the item's parent and selects
            // this exact PIDL. No Explorer command-line parsing of commas or
            // spaces; success is a Shell result rather than process creation.
            SHOpenFolderAndSelectItems(item.0,None,0).map_err(|_|"notes.fileOpenFailed")?;
        }
    }
    Ok(())
}
fn check_epoch(app:&AppHandle,expected:u64)->Result<(),String> {
    let db=app.state::<DbState>(); let _conn=db.conn.lock().map_err(|_| "notes.databaseFailed")?;
    if db.storage_epoch.load(Ordering::Relaxed)!=expected {return Err("notes.storageChanged".into());}
    crate::lifecycle::allow_write(app)
}
#[tauri::command]
pub async fn select_note_files(app:AppHandle,expected_storage_epoch:u64)->Result<StorageResult<Vec<NoteRef>>,String> {
    check_epoch(&app,expected_storage_epoch)?;
    let dialog=crate::NativeDialogScope::new().ok_or("notes.busy")?;
    let (send,receive)=tokio::sync::oneshot::channel();
    let parent=app.get_webview_window("main").ok_or("notes.fileDialogFailed")?;
    app.dialog().file().set_parent(&parent).pick_files(move |files| {let _dialog=dialog;let _=send.send(files);});
    let files=tokio::time::timeout(std::time::Duration::from_secs(120),receive).await.map_err(|_| "notes.fileDialogFailed")?
        .map_err(|_| "notes.fileDialogFailed")?;
    let Some(files)=files else {return Ok(StorageResult {storage_epoch:expected_storage_epoch,value:Vec::new()});};
    if files.len()>20 {return Err("notes.tooManyRefs".into());}
    check_epoch(&app,expected_storage_epoch)?;
    let refs:Vec<_>=files.into_iter().map(|file| {
        let target=file.to_string();
        let display_name=std::path::Path::new(&target).file_name().map(|v|v.to_string_lossy().to_string()).unwrap_or_else(||target.clone());
        NoteRef {id:uuid::Uuid::new_v4().to_string(),kind:"file".into(),target,display_name}
    }).collect();
    crate::notes::validate(&NoteDraft {title:String::new(),body:String::new(),refs:refs.clone()}).map_err(|e|e.code.to_string())?;
    Ok(StorageResult {storage_epoch:expected_storage_epoch,value:refs})
}
#[tauri::command]
pub async fn reveal_note_reference(app:AppHandle,expected_storage_epoch:u64,id:String,reference_id:String)->Result<(),String> {
    static IO:OnceLock<Arc<tokio::sync::Semaphore>>=OnceLock::new();
    let permit=IO.get_or_init(||Arc::new(tokio::sync::Semaphore::new(2))).clone().try_acquire_owned().map_err(|_| "notes.busy")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        let target:String={
            let db=app.state::<DbState>(); let conn=db.conn.lock().map_err(|_| "notes.databaseFailed")?;
            if db.storage_epoch.load(Ordering::Relaxed)!=expected_storage_epoch {return Err("notes.storageChanged".into());}
            conn.query_row("SELECT r.target FROM note_refs r JOIN notes n ON n.id=r.note_id WHERE n.id=?1 AND r.id=?2 AND r.kind='file' AND n.deleted_at_ms IS NULL",rusqlite::params![id,reference_id],|r|r.get(0)).map_err(|_| "notes.notFound")?
        };
        let path=std::path::Path::new(&target);
        if !path.is_absolute() || target.contains('\0') {return Err("notes.invalidRef".into());}
        let metadata=std::fs::metadata(path).map_err(|_| "notes.fileMissing")?;
        #[cfg(target_os="windows")]
        {
            reveal_path(path,metadata.is_dir())?;
        }
        #[cfg(not(target_os="windows"))]
        {let _=metadata; return Err("notes.fileOpenFailed".into());}
        Ok(())
    }).await.map_err(|_| "notes.fileOpenFailed")?
}
