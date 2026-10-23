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

/// Windows: socket AF_UNIX en %LOCALAPPDATA%\keel\keel.sock (ADR-0005 §1, revisión del
/// 2026-10-23; el Named Pipe de Bun daba lectura a Todos). tokio sólo tiene UnixStream en
/// Unix: el socket bloqueante de `uds_windows` se puentea a un DuplexStream con dos hilos.
/// Compilado y probado contra el daemon real en Windows con `cargo test` (2026-10-23).
#[cfg(windows)]
fn connect_af_unix(path: &str) -> Result<tokio::io::DuplexStream, String> {
    use std::io::{Read, Write};
    use tokio::io::AsyncReadExt;
    let socket = uds_windows::UnixStream::connect(path).map_err(|e| e.to_string())?;
    let mut from_daemon = socket.try_clone().map_err(|e| e.to_string())?;
    let mut to_daemon = socket;
    let (local, bridge) = tokio::io::duplex(1 << 20);
    let (mut bridge_rd, mut bridge_wr) = tokio::io::split(bridge);
    let rt = tokio::runtime::Handle::current();
    let rt_in = rt.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match from_daemon.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            if rt_in.block_on(bridge_wr.write_all(&buf[..n])).is_err() { break; }
        }
        let _ = rt_in.block_on(bridge_wr.shutdown());
    });
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match rt.block_on(bridge_rd.read(&mut buf)) { Ok(0) | Err(_) => break, Ok(n) => n };
            if to_daemon.write_all(&buf[..n]).is_err() { break; }
        }
        let _ = to_daemon.shutdown(std::net::Shutdown::Both);
    });
    Ok(local)
}

impl Session {
    pub async fn connect(path: &str, notify: Arc<dyn Fn(Value) + Send + Sync>) -> Result<Arc<Self>, String> {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(path).await.map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let stream = connect_af_unix(path)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("keel-tauri-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp");
        dir
    }

    fn request(id: u64, method: &str, params: Value) -> Value {
        serde_json::json!({ "jsonrpc": "2.0", "keel_protocol": 1, "id": id, "method": method, "params": params })
    }

    struct Daemon(Child, PathBuf);
    impl Drop for Daemon {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    /// El daemon real de TypeScript (packages/daemon) por el socket de la plataforma:
    /// socket Unix en POSIX, AF_UNIX en Windows (ADR-0005 §1).
    #[tokio::test(flavor = "multi_thread")]
    async fn habla_con_el_daemon_real() {
        let dir = scratch("daemon");
        let socket = dir.join("keel.sock");
        let main = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
        let child = Command::new("bun")
            .arg(&main)
            .args(["--db", dir.join("k.sqlite").to_str().unwrap(), "--socket", socket.to_str().unwrap(), "--root", dir.to_str().unwrap()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("bun en el PATH");
        let _daemon = Daemon(child, dir.clone());
        for _ in 0..100 {
            if socket.exists() { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let session = Session::connect(socket.to_str().unwrap(), Arc::new(move |f| { let _ = tx.send(f); }))
            .await
            .expect("conectar");
        let health = session.request(request(1, "daemon.health", serde_json::json!({}))).await.expect("health");
        assert!(health["result"]["event_loop_lag_ms"].is_number(), "{health}");
        session.request(request(2, "events.subscribe", serde_json::json!({ "after_event_seq": 0 }))).await.expect("subscribe");
        let created = session
            .request(request(3, "work_items.create", serde_json::json!({
                "request_id": "r1", "idempotency_key": "k1", "title": "desde Tauri: ñandú 🦀", "kind": "chore"
            })))
            .await
            .expect("create");
        assert_eq!(created["result"]["title"], "desde Tauri: ñandú 🦀");
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let f = rx.recv().await.expect("canal");
                if f["params"]["kind"] == "work_item.created" { return f; }
            }
        })
        .await
        .expect("evento por la suscripción");
        assert_eq!(event["params"]["payload"]["title"], "desde Tauri: ñandú 🦀");
        session.close();
    }

    /// Una «ñ» partida entre dos escrituras del servidor llega intacta (el puente de
    /// Windows copia bytes, nunca caracteres).
    #[tokio::test(flavor = "multi_thread")]
    async fn utf8_partido_entre_escrituras() {
        let dir = scratch("utf8");
        let path = dir.join("s.sock");
        // «Espa» + el primer byte de «ñ» (0xC3); el segundo (0xB1) va en la otra escritura.
        let mut reply = br#"{"jsonrpc":"2.0","keel_protocol":1,"id":7,"result":{"t":"Espa"#.to_vec();
        reply.push(0xc3);
        let rest = b"\xb1ol\"}}\n".to_vec();
        #[cfg(unix)]
        let server = {
            use tokio::io::AsyncReadExt;
            let listener = tokio::net::UnixListener::bind(&path).expect("bind");
            tokio::spawn(async move {
                let (mut s, _) = listener.accept().await.expect("accept");
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                s.write_all(&reply).await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
                s.write_all(&rest).await.unwrap();
                tokio::time::sleep(Duration::from_millis(200)).await;
            })
        };
        #[cfg(windows)]
        let server = {
            use std::io::{Read, Write};
            let listener = uds_windows::UnixListener::bind(&path).expect("bind");
            tokio::task::spawn_blocking(move || {
                let (mut s, _) = listener.accept().expect("accept");
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                s.write_all(&reply).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                s.write_all(&rest).unwrap();
                std::thread::sleep(Duration::from_millis(200));
            })
        };
        let session = Session::connect(path.to_str().unwrap(), Arc::new(|_| {})).await.expect("conectar");
        let r = session.request(request(7, "daemon.health", serde_json::json!({}))).await.expect("respuesta");
        assert_eq!(r["result"]["t"], "Español");
        session.close();
        let _ = server.await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
