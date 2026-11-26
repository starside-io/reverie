// Reverie as a desktop app. Lifted from Fellowship's desktop shell.
//
// This is a window over the same one process host that `reverie serve` runs,
// and nothing else. It starts that host with the Node runtime bundled beside
// it, waits for /health, points a webview at it, and stops it on quit. The UI
// talks to the host over HTTP on loopback exactly as a browser tab does, so
// the desktop app gets no path into the silo the browser does not have, and
// is granted no Tauri commands at all.
//
// If a Reverie host is already answering on the usual port and runs the same
// code as this app (same surface fingerprint), it is reused rather than
// started again: the silo has one writer, and host.lock refuses a second host
// over the same files anyway. Unlike Fellowship's shell, this one never stops
// a host it did not start. A host running other code is named in the window,
// and the owner stops it; the app only ever stops its own child.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The port the CLI uses, so the two find each other. Fellowship's is 4319.
const PREFERRED_PORT: u16 = 4329;

/// How long the host gets to migrate, open the silo and bind.
const STARTUP_BUDGET: Duration = Duration::from_secs(45);

/// How long the host gets to close the silo after SIGTERM before it is killed.
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(8);

/// The least time the splash stays up, so a host that is already running does
/// not turn it into a flash.
const MIN_SPLASH: Duration = Duration::from_millis(1400);

/// The fingerprint of the host this app bundles, from scripts/bundle.mjs.
const FINGERPRINT: Option<&str> = option_env!("REVERIE_FINGERPRINT");

/// The host process, when this app started it. None when one was reused.
struct Host(Mutex<Option<Child>>);

/// What the window should do once the host question is settled.
enum Plan {
    /// Start our own host on this port.
    Start(u16),
    /// A host running this code is already up on this port.
    Reuse(u16),
    /// A host running other code holds the usual port. Say so, touch nothing.
    Blocked { port: u16, pid: Option<String> },
}

/// One field of the /health body: a number or a string, as text. The body is
/// small and flat, so this stays clear of a JSON dependency.
fn field(body: &str, key: &str) -> Option<String> {
    let start = body.find(&format!("\"{key}\":"))? + key.len() + 3;
    let rest = body[start..].trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        return quoted.find('"').map(|end| quoted[..end].to_string());
    }
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    (end > 0).then(|| rest[..end].to_string())
}

/// The /health body when a Reverie host answers on this port. Checks the body
/// as well as the status, so some other server that happens to own the port
/// is not mistaken for one.
fn health(port: u16) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let ok = response.starts_with("HTTP/1.1 200")
        && response.contains("\"ok\":true")
        && response.contains("\"tools\"")
        && response.contains("\"silo\"");
    ok.then_some(response)
}

fn is_reverie(port: u16) -> bool {
    health(port).is_some()
}

/// Where the host should be: reuse one running this code, else the usual
/// port if it is free, else whatever the OS hands out.
fn choose() -> Plan {
    if let Some(body) = health(PREFERRED_PORT) {
        return match FINGERPRINT {
            // A build without a stamp cannot tell old code from new.
            None => Plan::Reuse(PREFERRED_PORT),
            Some(ours) if field(&body, "fingerprint").as_deref() == Some(ours) => Plan::Reuse(PREFERRED_PORT),
            Some(_) => Plan::Blocked { port: PREFERRED_PORT, pid: field(&body, "pid") },
        };
    }
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return Plan::Start(PREFERRED_PORT);
    }
    let port = TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(PREFERRED_PORT);
    Plan::Start(port)
}

/// Stops the host this app started: SIGTERM to its pid alone, so it closes
/// the silo and drops host.lock, then a kill if it has not gone in time.
fn stop_child(child: &mut Child) {
    let _ = Command::new("/bin/kill").arg(child.id().to_string()).status();
    let deadline = Instant::now() + SHUTDOWN_BUDGET;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn message(text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('\'', "\\'");
    format!(
        "document.body.innerHTML = '<main style=\"max-width:34rem;margin:20vh auto;padding:0 24px;font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\"><p>{escaped}</p></main>';"
    )
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let plan = choose();
            let blocked = match &plan {
                Plan::Blocked { port, pid } => Some((*port, pid.clone())),
                _ => None,
            };

            let (port, child) = match plan {
                Plan::Reuse(port) => (Some(port), None),
                Plan::Blocked { .. } => (None, None),
                Plan::Start(port) => {
                    let resources = app.path().resource_dir()?;
                    let runtime = std::env::current_exe()?
                        .parent()
                        .map(|directory| directory.join("node"))
                        .ok_or("no directory beside the executable")?;

                    // The host's own output goes to a log the user can find,
                    // rather than to a pipe nobody reads, which would fill and
                    // stall the process.
                    let logs = app.path().app_log_dir()?;
                    create_dir_all(&logs)?;
                    let log = OpenOptions::new().create(true).append(true).open(logs.join("host.log"))?;

                    let child = Command::new(runtime)
                        .arg(resources.join("server").join("dist").join("cli.js"))
                        .args(["serve", "--port", &port.to_string()])
                        .env("REVERIE_UI_DIR", resources.join("ui"))
                        // The host exits when this pid does, so a crash of the
                        // app never leaves it running with the silo open.
                        .env("REVERIE_PARENT_PID", std::process::id().to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::from(log.try_clone()?))
                        .stderr(Stdio::from(log))
                        .spawn()?;
                    (Some(port), Some(child))
                }
            };

            app.manage(Host(Mutex::new(child)));

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Reverie")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            let shown = Instant::now();
            thread::spawn(move || {
                if let Some((port, pid)) = blocked {
                    let who = pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default();
                    thread::sleep(MIN_SPLASH);
                    let _ = window.eval(&message(&format!(
                        "A Reverie host running other code is already up on port {port}{who}. The app does not stop a host it did not start. Stop that one (Ctrl+C where it runs, or reverie restart), then open the app again."
                    )));
                    return;
                }
                let Some(port) = port else { return };
                let deadline = Instant::now() + STARTUP_BUDGET;
                while Instant::now() < deadline {
                    if is_reverie(port) {
                        if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
                            thread::sleep(MIN_SPLASH.saturating_sub(shown.elapsed()));
                            let _ = window.navigate(url);
                        }
                        return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                let _ = window.eval(&message(
                    "The host did not start. Another Reverie host may be running on a different port: it refuses a second one over the same silo. Its log is host.log in the app log folder.",
                ));
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Reverie could not start its window");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Only the host this app started is stopped. One that was already
            // running belongs to whoever started it.
            if let Some(host) = handle.try_state::<Host>() {
                if let Ok(mut guard) = host.0.lock() {
                    if let Some(mut child) = guard.take() {
                        stop_child(&mut child);
                    }
                }
            }
        }
    });
}
