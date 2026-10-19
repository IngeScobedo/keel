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

#[tauri::command]
async fn ipc_disconnect(bridge: State<'_, Bridge>) -> Result<(), String> {
    if let Some(session) = bridge.0.lock().await.take() { session.close(); }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![ipc_connect, ipc_request, ipc_disconnect])
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar Keel GUI");
}
