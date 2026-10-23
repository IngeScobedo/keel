//! Arranque del daemon de usuario (ADR-0019 §1). La ventana no contiene al daemon:
//! si nadie escucha en el endpoint, lo lanza desligado de ella y espera a que
//! responda. Cerrar la ventana no lo detiene; los runs siguen.
use crate::transport::Session;
use std::{
    fs::OpenOptions,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

/// ¿Hay un daemon escuchando? Un socket huérfano rechaza la conexión.
async fn alive(path: &str) -> bool {
    match Session::connect(path, Arc::new(|_| {})).await {
        Ok(s) => {
            s.close();
            true
        }
        Err(_) => false,
    }
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

/// `bun` del PATH o de `~/.bun/bin`.
fn find_bun() -> Option<PathBuf> {
    if let Some(b) = var("BUN") {
        return Some(PathBuf::from(b));
    }
    let exe = if cfg!(windows) { "bun.exe" } else { "bun" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let home = var("HOME").or_else(|| var("USERPROFILE"))?;
    let p = PathBuf::from(home).join(".bun").join("bin").join(exe);
    p.is_file().then_some(p)
}

/// Qué lanzar: `KEEL_DAEMON` (programa y argumentos separados por espacios) o, en
/// desarrollo, `bun packages/daemon/src/main.ts` de este repo.
fn command() -> Result<(PathBuf, Vec<String>), String> {
    if let Some(cmd) = var("KEEL_DAEMON") {
        let mut parts = cmd.split_whitespace().map(String::from);
        let program = parts.next().ok_or("KEEL_DAEMON vacío")?;
        return Ok((PathBuf::from(program), parts.collect()));
    }
    let main = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
    if !main.is_file() {
        return Err("No encuentro el daemon; define KEEL_DAEMON con el comando que lo arranca".into());
    }
    let bun = find_bun().ok_or("No encuentro bun; instálalo o define BUN o KEEL_DAEMON")?;
    Ok((bun, vec![main.to_string_lossy().into_owned()]))
}

/// Registro del daemon lanzado por la ventana, junto a su base (`~/.keel`).
fn log_path() -> PathBuf {
    if let Some(p) = var("KEEL_DAEMON_LOG") {
        return PathBuf::from(p);
    }
    let base = if cfg!(windows) {
        var("LOCALAPPDATA").map(|d| PathBuf::from(d).join("keel"))
    } else {
        var("HOME").map(|h| PathBuf::from(h).join(".keel"))
    };
    base.unwrap_or_else(std::env::temp_dir).join("daemon.log")
}

fn spawn(path: &str) -> Result<(PathBuf, u32), String> {
    let (program, mut args) = command()?;
    args.push("--socket".into());
    args.push(path.into());
    let log = log_path();
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let out = OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&program);
    cmd.args(&args).stdin(Stdio::null()).stdout(out).stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Su propio grupo: no recibe las señales de la terminal ni muere con la ventana.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("No se pudo lanzar {}: {e}", program.display()))?;
    Ok((log, child.id()))
}

/// Un arranque a la vez: dos llamadas simultáneas (React monta dos veces en
/// desarrollo) lanzaban dos daemons y el segundo moría con la base bloqueada.
static ENSURING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `running` si ya había uno; `started` (con su pid) si lo lanzó esta ventana.
pub async fn ensure(path: &str) -> Result<(&'static str, Option<u32>), String> {
    let _one = ENSURING.lock().await;
    if alive(path).await {
        return Ok(("running", None));
    }
    let (log, pid) = spawn(path)?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if alive(path).await {
            return Ok(("started", Some(pid)));
        }
    }
    Err(format!("El daemon no respondió en 20 s; revisa {}", log.display()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Sin daemon, lo lanza desligado y responde; con daemon, no lanza otro.
    #[tokio::test(flavor = "multi_thread")]
    async fn arranca_el_daemon_si_nadie_escucha() {
        let dir = std::env::temp_dir().join(format!("keel-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let main = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/main.ts");
        let bun = find_bun().expect("bun");
        // Base propia: nunca la del usuario.
        std::env::set_var(
            "KEEL_DAEMON",
            format!(
                "{} {} --db {} --root {}",
                bun.display(),
                main.display(),
                dir.join("k.sqlite").display(),
                dir.display()
            ),
        );
        std::env::set_var("KEEL_DAEMON_LOG", dir.join("daemon.log"));
        let sock = dir.join("k.sock").to_string_lossy().into_owned();
        // Dos llamadas a la vez sin daemon: una lo lanza y la otra lo encuentra.
        let (a, b) = tokio::join!(ensure(&sock), ensure(&sock));
        let (a, b) = (a.expect("a"), b.expect("b"));
        let mut states = [a.0, b.0];
        states.sort();
        assert_eq!(states, ["running", "started"]);
        let pid = a.1.or(b.1);
        let _ = Command::new("kill").arg(pid.unwrap().to_string()).status();
        for _ in 0..50 {
            if !alive(&sock).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!alive(&sock).await);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
