//! Transporte fino de ADR-0003/0005. No conoce tareas, SQLite ni proveedores.
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader}, sync::oneshot, task::JoinHandle};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
type Pending = HashMap<String, oneshot::Sender<Result<Value, String>>>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

pub struct Session {
    writer: tokio::sync::Mutex<Writer>,
    pending: Mutex<Pending>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl Session {
    pub async fn connect(path: &str, notify: Arc<dyn Fn(Value) + Send + Sync>) -> Result<Arc<Self>, String> {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(path).await.map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(path).map_err(|e| e.to_string())?;
        #[cfg(not(any(unix, windows)))]
        return Err("Plataforma de socket no soportada".into());
        let (reader, writer) = tokio::io::split(stream);
        let session = Arc::new(Self { writer: tokio::sync::Mutex::new(Box::new(writer)), pending: Mutex::new(HashMap::new()), reader: Mutex::new(None) });
        let weak = Arc::downgrade(&session);
        let task = tokio::spawn(async move {
            let mut input = BufReader::new(reader);
            loop {
                let line = match read_frame(&mut input).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => break,
                };
                let frame: Value = match serde_json::from_slice(&line) { Ok(frame) => frame, Err(_) => break };
                if frame.get("keel_protocol").and_then(Value::as_u64) != Some(1) || frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { break; }
                let Some(current) = weak.upgrade() else { break; };
                if let Some(id) = frame.get("id") {
                    if let Some(sender) = current.pending.lock().expect("pending mutex").remove(&id.to_string()) { let _ = sender.send(Ok(frame)); }
                } else if frame.get("method").is_some() { notify(frame); }
            }
            if let Some(current) = weak.upgrade() { current.fail_pending("La conexión con el daemon se cerró"); }
        });
        *session.reader.lock().expect("reader mutex") = Some(task);
        Ok(session)
    }

    pub async fn request(&self, frame: Value) -> Result<Value, String> {
        if frame.get("keel_protocol").and_then(Value::as_u64) != Some(1) || frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("Envelope IPC inválido".into());
        }
        let id = frame.get("id").filter(|id| id.is_string() || id.is_i64() || id.is_u64()).ok_or("Falta request ID")?.to_string();
        let mut bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_FRAME_BYTES { return Err("Frame supera 8 MiB".into()); }
        bytes.push(b'\n');
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending mutex");
            if pending.contains_key(&id) { return Err("Request ID duplicado".into()); }
            pending.insert(id.clone(), send);
        }
        let result = {
            let mut writer = self.writer.lock().await;
            writer.write_all(&bytes).await.map_err(|e| e.to_string())
        };
        if let Err(error) = result {
            self.pending.lock().expect("pending mutex").remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(Duration::from_secs(30), receive).await;
        self.pending.lock().expect("pending mutex").remove(&id);
        match result { Ok(Ok(result)) => result, Ok(Err(_)) => Err("Conexión cerrada".into()), Err(_) => Err("Timeout IPC; la mutación puede haberse aplicado. No se reintenta automáticamente.".into()) }
    }

    fn fail_pending(&self, reason: &str) {
        for (_, send) in self.pending.lock().expect("pending mutex").drain() { let _ = send.send(Err(reason.into())); }
    }
    pub fn close(&self) {
        if let Some(task) = self.reader.lock().expect("reader mutex").take() { task.abort(); }
        self.fail_pending("Conexión cerrada por el cliente");
    }
}
impl Drop for Session { fn drop(&mut self) { self.close(); } }

/// Buffer acotado por bytes: UTF-8 se decodifica sólo cuando llegó la línea completa.
async fn read_frame<R: AsyncRead + Unpin>(input: &mut BufReader<R>) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let chunk = input.fill_buf().await.map_err(|e| e.to_string())?;
        if chunk.is_empty() { return if frame.is_empty() { Ok(None) } else { Err("Frame truncado".into()) }; }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let count = newline.map(|pos| pos + 1).unwrap_or(chunk.len());
        if frame.len() + count > MAX_FRAME_BYTES + 1 { return Err("Frame supera 8 MiB".into()); }
        frame.extend_from_slice(&chunk[..count]);
        input.consume(count);
        if newline.is_some() { frame.pop(); return Ok(Some(frame)); }
    }
}
