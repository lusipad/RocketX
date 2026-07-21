mod runtime;

use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use runtime::{EventSink, IpmsgRuntimeState};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

fn string_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string parameter: {key}"))
}

fn optional_string_param(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn dispatch(state: &IpmsgRuntimeState, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "start" => serde_json::to_value(runtime::start(
            state,
            string_param(&params, "userName")?,
            string_param(&params, "nickname")?,
            optional_string_param(&params, "group"),
            optional_string_param(&params, "discoveryRanges"),
        )?)
        .map_err(|error| error.to_string()),
        "stop" => runtime::stop(state).map(|_| json!({ "ok": true })),
        "status" => {
            serde_json::to_value(runtime::status(state)?).map_err(|error| error.to_string())
        }
        "validateDiscoveryRanges" => {
            runtime::validate_discovery_ranges(&string_param(&params, "discoveryRanges")?)
                .map(|count| json!({ "count": count }))
        }
        "peers" => serde_json::to_value(runtime::peers(state)?).map_err(|error| error.to_string()),
        "sendMessage" => serde_json::to_value(runtime::send_message(
            state,
            string_param(&params, "peerId")?,
            string_param(&params, "text")?,
        )?)
        .map_err(|error| error.to_string()),
        "offerFile" => serde_json::to_value(runtime::offer_file(
            state,
            string_param(&params, "peerId")?,
            string_param(&params, "path")?,
        )?)
        .map_err(|error| error.to_string()),
        "downloadFile" => serde_json::to_value(runtime::download_file(
            state,
            string_param(&params, "offerId")?,
        )?)
        .map_err(|error| error.to_string()),
        _ => Err(format!("unknown method: {method}")),
    }
}

fn write_frame(output: &Arc<Mutex<io::Stdout>>, frame: &Value) {
    let Ok(mut output) = output.lock() else {
        return;
    };
    if serde_json::to_writer(&mut *output, frame).is_ok() {
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }
}

fn main() {
    let output = Arc::new(Mutex::new(io::stdout()));
    let event_output = output.clone();
    let events: EventSink = Arc::new(move |event, payload| {
        write_frame(
            &event_output,
            &json!({
                "jsonrpc": "2.0",
                "method": "event",
                "params": { "event": event, "payload": payload },
            }),
        );
    });
    let download_root = env::var_os("ROCKETX_NATIVE_SERVICE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("rocketx-native-service"))
        .join("downloads");
    let state = IpmsgRuntimeState::new(events, download_root);
    let _ = runtime::start(
        &state,
        "rocketx".to_string(),
        "RocketX".to_string(),
        Some("RocketX".to_string()),
        None,
    );

    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) if line.len() <= MAX_FRAME_BYTES => line,
            Ok(_) => continue,
            Err(_) => break,
        };
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };
        let response = match dispatch(&state, &request.method, request.params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": request.id, "result": result }),
            Err(message) => json!({
                "jsonrpc": "2.0",
                "id": request.id,
                "error": { "code": -32000, "message": message },
            }),
        };
        write_frame(&output, &response);
    }

    runtime::shutdown(&state);
}
