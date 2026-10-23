#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod transport;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::Mutex;
use transport::Session;

#[derive(Default)]
struct Bridge(Mutex<Option<Arc<Session>>>);

#[tauri::command]
async fn ipc_connect(path: String, app: tauri::AppHandle, bridge: State<'_, Bridge>) -> Result<(), String> {
    let mut current = bridge.0.lock().await;
    if let Some(old) = current.take() { old.close(); }
    let session = Session::connect(&path, Arc::new(move |frame| {
        let _ = app.emit("keel://notification", frame);
    })).await?;
    *current = Some(session);
    Ok(())
}

#[tauri::command]
async fn ipc_request(frame: Value, bridge: State<'_, Bridge>) -> Result<Value, String> {
    let session = bridge.0.lock().await.clone().ok_or("Daemon no conectado")?;
    session.request(frame).await
}

/// La misma ruta por defecto que `ipc/endpoint.ts` del daemon; `KEEL_SOCKET` la sustituye.
#[tauri::command]
fn ipc_default_path() -> String {
    if let Some(p) = std::env::var_os("KEEL_SOCKET").filter(|p| !p.is_empty()) {
        return p.to_string_lossy().into_owned();
    }
    let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(std::path::PathBuf::from);
    #[cfg(windows)]
    let base = var("LOCALAPPDATA")
        .or_else(|| var("USERPROFILE").map(|h| h.join("AppData").join("Local")))
        .unwrap_or_default()
        .join("keel");
    #[cfg(not(windows))]
    let base = var("XDG_RUNTIME_DIR")
        .map(|d| d.join("keel"))
        .or_else(|| var("HOME").map(|h| h.join(".keel")))
        .unwrap_or_default();
    base.join("keel.sock").to_string_lossy().into_owned()
}

#[tauri::command]
async fn ipc_disconnect(bridge: State<'_, Bridge>) -> Result<(), String> {
    if let Some(session) = bridge.0.lock().await.take() { session.close(); }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![ipc_connect, ipc_request, ipc_disconnect, ipc_default_path])
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar Keel GUI");
}
