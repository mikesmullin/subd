use base64::Engine;
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

fn write_json_line(stream: &mut TcpStream, value: &Value) -> io::Result<()> {
    let mut line = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    line.push(b'\n');
    stream.write_all(&line)
}

fn current_request_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("cmd_proxy-{}-{}", process::id(), now)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cmd_proxy error: {}", error);
        process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let host = env::var("SUBD_SANDBOX_HOST")
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "SUBD_SANDBOX_HOST is not set"))?;
    let port = env::var("SUBD_SANDBOX_PORT")
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "SUBD_SANDBOX_PORT is not set"))?;
    let token = env::var("SUBD_SANDBOX_TOKEN")
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "SUBD_SANDBOX_TOKEN is not set"))?;

    let mut args: Vec<String> = env::args().collect();
    let invoked_as = args
        .first()
        .and_then(|value| value.rsplit('/').next())
        .unwrap_or("cmd_proxy")
        .to_string();

    let is_symlink_mode = invoked_as != "cmd_proxy";

    let command = if is_symlink_mode {
        invoked_as.clone()
    } else {
        if args.len() < 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Usage: cmd_proxy <command> [args...] (or invoke via symlink name like jira)",
            ));
        }
        args.remove(1)
    };

    let command_args = if is_symlink_mode {
        args.into_iter().skip(1).collect::<Vec<_>>()
    } else {
        args.into_iter().skip(1).collect::<Vec<_>>()
    };

    let address = format!("{}:{}", host, port);
    let mut stream = TcpStream::connect(address)?;
    stream.set_nodelay(true)?;

    let request_id = current_request_id();
    let start_message = json!({
        "id": request_id,
        "token": token,
        "type": "cmd_proxy_exec_start",
        "command": command,
        "args": command_args
    });
    write_json_line(&mut stream, &start_message)?;

    let reader_stream = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));

    let stdin_writer = Arc::clone(&writer);
    let stdin_token = token.clone();
    let stdin_request_id = request_id.clone();
    let stdin_handle = thread::spawn(move || -> io::Result<()> {
        let mut stdin = io::stdin();
        let mut buffer = [0u8; 8192];

        loop {
            let read = stdin.read(&mut buffer)?;
            if read == 0 {
                break;
            }

            let chunk_b64 = base64::engine::general_purpose::STANDARD.encode(&buffer[..read]);
            let msg = json!({
                "id": stdin_request_id,
                "token": stdin_token,
                "type": "cmd_proxy_stdin",
                "chunk": chunk_b64
            });

            if let Ok(mut locked) = stdin_writer.lock() {
                write_json_line(&mut locked, &msg)?;
            }
        }

        let end_msg = json!({
            "id": stdin_request_id,
            "token": stdin_token,
            "type": "cmd_proxy_stdin_end"
        });
        if let Ok(mut locked) = stdin_writer.lock() {
            write_json_line(&mut locked, &end_msg)?;
        }

        Ok(())
    });

    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    let mut exit_code: i32 = 1;

    loop {
        line.clear();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }

        let message: Value = match serde_json::from_str(line.trim()) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if message.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
            continue;
        }

        if message.get("ok").and_then(Value::as_bool) == Some(false) {
            if let Some(error) = message.get("error").and_then(Value::as_str) {
                eprintln!("{}", error);
            } else {
                eprintln!("cmd_proxy host request failed");
            }
            exit_code = 1;
            break;
        }

        if let Some(stream_name) = message.get("stream").and_then(Value::as_str) {
            let chunk = message
                .get("chunk")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !chunk.is_empty() {
                if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(chunk) {
                    match stream_name {
                        "stdout" => {
                            io::stdout().write_all(&decoded)?;
                            io::stdout().flush()?;
                        }
                        "stderr" => {
                            io::stderr().write_all(&decoded)?;
                            io::stderr().flush()?;
                        }
                        _ => {}
                    }
                }
            }
            continue;
        }

        if message.get("event").and_then(Value::as_str) == Some("exit") {
            exit_code = message
                .get("exitCode")
                .and_then(Value::as_i64)
                .unwrap_or(1) as i32;
            break;
        }
    }

    let _ = stdin_handle;

    process::exit(exit_code);
}
