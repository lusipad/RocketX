//! JSONL correlation owned by the native process, independently of a WebView.
//! One bounded queue and writer thread serve each connection. The owner kills
//! its child on disconnect, releasing a blocked pipe. No request is retried.

use std::{
    collections::HashMap,
    fmt, io,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

pub(crate) const MAX_CODEX_RPC_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUEUED_WRITES: usize = 16;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RpcFailure {
    NotSent { reason: String },
    Unknown { reason: String },
    Rejected { error: Value },
}

impl fmt::Display for RpcFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotSent { reason } => write!(formatter, "Codex request not sent: {reason}"),
            Self::Unknown { reason } => write!(formatter, "Codex outcome unknown: {reason}"),
            Self::Rejected { error } => write!(formatter, "Codex rejected request: {error}"),
        }
    }
}

impl std::error::Error for RpcFailure {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InboundMessage {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Disconnected {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProtocolFailure {
    MessageTooLarge,
    InvalidJson,
    InvalidEnvelope,
    DuplicateServerRequest,
}

impl fmt::Display for ProtocolFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid Codex JSONL message: {self:?}")
    }
}

impl std::error::Error for ProtocolFailure {}

struct PendingRequest {
    sender: Sender<Result<Value, RpcFailure>>,
    write_attempted: bool,
    write_finished: bool,
    wait_for_response: bool,
    response: Option<Result<Value, RpcFailure>>,
    server_request_key: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ServerRequestState {
    Pending,
    Reserved,
    Answered,
}

struct WriteJob {
    id: String,
    frame: Vec<u8>,
    started: Instant,
    timeout: Duration,
}

#[derive(Default)]
struct State {
    disconnected: Option<String>,
    pending: HashMap<String, PendingRequest>,
    server_requests: HashMap<String, ServerRequestState>,
}

type InboundSink = dyn Fn(InboundMessage) + Send + Sync;

pub(crate) struct NativeCodexRpc {
    writes: SyncSender<Option<WriteJob>>,
    sink: Arc<InboundSink>,
    state: Arc<Mutex<State>>,
    write_timeout: Duration,
    #[cfg(test)]
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl NativeCodexRpc {
    pub(crate) fn new(
        write: impl Fn(&[u8]) -> io::Result<()> + Send + Sync + 'static,
        sink: impl Fn(InboundMessage) + Send + Sync + 'static,
    ) -> Self {
        Self::with_write_timeout(write, sink, WRITE_TIMEOUT)
    }

    fn with_write_timeout(
        write: impl Fn(&[u8]) -> io::Result<()> + Send + Sync + 'static,
        sink: impl Fn(InboundMessage) + Send + Sync + 'static,
        write_timeout: Duration,
    ) -> Self {
        let (writes, receiver) = mpsc::sync_channel::<Option<WriteJob>>(MAX_QUEUED_WRITES);
        let state = Arc::new(Mutex::new(State::default()));
        let sink: Arc<InboundSink> = Arc::new(sink);
        let worker_state = Arc::clone(&state);
        let worker_sink = Arc::clone(&sink);
        let _worker = thread::spawn(move || {
            while let Ok(Some(job)) = receiver.recv() {
                {
                    let mut state = worker_state.lock().unwrap();
                    if state.disconnected.is_some() {
                        break;
                    }
                    let Some(pending) = state.pending.get_mut(&job.id) else {
                        continue;
                    };
                    if job.started.elapsed() >= job.timeout {
                        let pending = state.pending.remove(&job.id).unwrap();
                        restore_unsent_approval(&mut state, &pending);
                        let _ = pending.sender.send(Err(not_sent("timeout before write")));
                        continue;
                    }
                    pending.write_attempted = true;
                    if let Some(key) = pending.server_request_key.clone() {
                        state
                            .server_requests
                            .insert(key, ServerRequestState::Answered);
                    }
                }
                if let Err(error) = write(&job.frame) {
                    disconnect_shared(
                        &worker_state,
                        &worker_sink,
                        &format!("stdin write failed: {error}"),
                    );
                    break;
                }
                if job.started.elapsed() >= job.timeout {
                    disconnect_shared(&worker_state, &worker_sink, "timeout after write started");
                    break;
                }
                let mut state = worker_state.lock().unwrap();
                if let Some(pending) = state.pending.get_mut(&job.id) {
                    pending.write_finished = true;
                    if !pending.wait_for_response || pending.response.is_some() {
                        let pending = state.pending.remove(&job.id).unwrap();
                        let result = pending.response.unwrap_or(Ok(Value::Null));
                        let _ = pending.sender.send(result);
                    }
                }
            }
        });
        Self {
            writes,
            sink,
            state,
            write_timeout,
            #[cfg(test)]
            worker: Mutex::new(Some(_worker)),
        }
    }

    /// The deadline includes queueing, writing, and waiting for the response.
    pub(crate) fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcFailure> {
        let started = Instant::now();
        let id = next_request_id();
        let frame = encode_message(
            method,
            json!({ "id": id, "method": method, "params": params }),
        )?;
        self.send(
            WriteJob {
                id,
                frame,
                started,
                timeout,
            },
            true,
            None,
        )
    }

    pub(crate) fn notify(&self, method: &str, params: Value) -> Result<(), RpcFailure> {
        let frame = encode_message(method, json!({ "method": method, "params": params }))?;
        self.send(
            WriteJob {
                id: next_request_id(),
                frame,
                started: Instant::now(),
                timeout: self.write_timeout,
            },
            false,
            None,
        )
        .map(|_| ())
    }

    /// Answers only a server request received on this connection, once. An
    /// uncertain write consumes the request; callers must not replay approval.
    pub(crate) fn respond(
        &self,
        server_request_id: &Value,
        result: Value,
    ) -> Result<(), RpcFailure> {
        let key = request_id_key(server_request_id).ok_or_else(|| RpcFailure::NotSent {
            reason: "invalid server request id".into(),
        })?;
        let frame = encode_frame(json!({ "id": server_request_id, "result": result }))?;
        self.send(
            WriteJob {
                id: next_request_id(),
                frame,
                started: Instant::now(),
                timeout: self.write_timeout,
            },
            false,
            Some(key),
        )
        .map(|_| ())
    }

    pub(crate) fn reject(
        &self,
        server_request_id: &Value,
        code: i64,
        message: &str,
    ) -> Result<(), RpcFailure> {
        let key = request_id_key(server_request_id)
            .ok_or_else(|| not_sent("invalid server request id"))?;
        let frame = encode_frame(
            json!({ "id": server_request_id, "error": { "code": code, "message": message } }),
        )?;
        self.send(
            WriteJob {
                id: next_request_id(),
                frame,
                started: Instant::now(),
                timeout: self.write_timeout,
            },
            false,
            Some(key),
        )
        .map(|_| ())
    }

    fn send(
        &self,
        job: WriteJob,
        wait_for_response: bool,
        server_request_key: Option<String>,
    ) -> Result<Value, RpcFailure> {
        let id = job.id.clone();
        let started = job.started;
        let timeout = job.timeout;
        let (sender, receiver) = mpsc::channel();
        {
            let mut state = self.state.lock().unwrap();
            ensure_connected(&state)?;
            if started.elapsed() >= timeout {
                return Err(not_sent("timeout before write"));
            }
            if let Some(key) = &server_request_key {
                if state.server_requests.get(key) != Some(&ServerRequestState::Pending) {
                    return Err(not_sent("no pending server request for id"));
                }
                state
                    .server_requests
                    .insert(key.clone(), ServerRequestState::Reserved);
            }
            state.pending.insert(
                id.clone(),
                PendingRequest {
                    sender,
                    write_attempted: false,
                    write_finished: false,
                    wait_for_response,
                    response: None,
                    server_request_key,
                },
            );
        }
        if self.writes.try_send(Some(job)).is_err() {
            let mut state = self.state.lock().unwrap();
            if let Some(pending) = state.pending.remove(&id) {
                restore_unsent_approval(&mut state, &pending);
            }
            return Err(not_sent("writer queue is full or closed"));
        }
        match receiver.recv_timeout(timeout.saturating_sub(started.elapsed())) {
            Ok(result) => result,
            Err(error) => {
                let mut state = self.state.lock().unwrap();
                if let Some(pending) = state.pending.remove(&id) {
                    if !pending.write_attempted {
                        restore_unsent_approval(&mut state, &pending);
                        return Err(not_sent("timeout before write"));
                    }
                } else if let Ok(result) = receiver.try_recv() {
                    return result;
                }
                drop(state);
                let reason = match error {
                    RecvTimeoutError::Timeout => "timeout after write started",
                    RecvTimeoutError::Disconnected => "response channel closed after write started",
                };
                self.disconnect(reason);
                Err(RpcFailure::Unknown {
                    reason: reason.into(),
                })
            }
        }
    }

    pub(crate) fn on_line(&self, line: &str) -> Result<(), ProtocolFailure> {
        if line.len() > MAX_CODEX_RPC_LINE_BYTES {
            return Err(ProtocolFailure::MessageTooLarge);
        }
        let message: Value =
            serde_json::from_str(line).map_err(|_| ProtocolFailure::InvalidJson)?;
        let object = message
            .as_object()
            .ok_or(ProtocolFailure::InvalidEnvelope)?;
        if let Some(method) = object.get("method") {
            let method = method
                .as_str()
                .filter(|method| !method.trim().is_empty())
                .ok_or(ProtocolFailure::InvalidEnvelope)?;
            if object.contains_key("result") || object.contains_key("error") {
                return Err(ProtocolFailure::InvalidEnvelope);
            }
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            let inbound = {
                let mut state = self.state.lock().unwrap();
                if state.disconnected.is_some() {
                    return Ok(());
                }
                if let Some(id) = object.get("id") {
                    let key = request_id_key(id).ok_or(ProtocolFailure::InvalidEnvelope)?;
                    if state.server_requests.contains_key(&key) {
                        return Err(ProtocolFailure::DuplicateServerRequest);
                    }
                    state
                        .server_requests
                        .insert(key, ServerRequestState::Pending);
                    InboundMessage::ServerRequest {
                        id: id.clone(),
                        method: method.into(),
                        params,
                    }
                } else {
                    InboundMessage::Notification {
                        method: method.into(),
                        params,
                    }
                }
            };
            (self.sink)(inbound);
            return Ok(());
        }
        let id = object.get("id").ok_or(ProtocolFailure::InvalidEnvelope)?;
        request_id_key(id).ok_or(ProtocolFailure::InvalidEnvelope)?;
        let result = match (object.get("result"), object.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => Err(RpcFailure::Rejected {
                error: error.clone(),
            }),
            _ => return Err(ProtocolFailure::InvalidEnvelope),
        };
        if let Some(id) = id.as_str() {
            let mut state = self.state.lock().unwrap();
            if let Some(pending) = state.pending.get_mut(id) {
                if pending.wait_for_response && pending.write_attempted {
                    if pending.write_finished {
                        let pending = state.pending.remove(id).unwrap();
                        let _ = pending.sender.send(result);
                    } else if pending.response.is_none() {
                        pending.response = Some(result);
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn disconnect(&self, reason: &str) {
        disconnect_shared(&self.state, &self.sink, reason);
        let _ = self.writes.try_send(None);
    }

    #[cfg(test)]
    fn join_writer(&self) {
        self.disconnect("test finished");
        if let Some(worker) = self.worker.lock().unwrap().take() {
            worker.join().unwrap();
        }
    }
}

impl Drop for NativeCodexRpc {
    fn drop(&mut self) {
        self.disconnect("native connection dropped");
    }
}

fn disconnect_shared(state: &Mutex<State>, sink: &Arc<InboundSink>, reason: &str) {
    let mut state = state.lock().unwrap();
    if state.disconnected.is_some() {
        return;
    }
    state.disconnected = Some(reason.into());
    state.server_requests.clear();
    for (_, pending) in state.pending.drain() {
        let failure = if pending.write_attempted {
            RpcFailure::Unknown {
                reason: reason.into(),
            }
        } else {
            RpcFailure::NotSent {
                reason: reason.into(),
            }
        };
        let _ = pending.sender.send(Err(failure));
    }
    drop(state);
    sink(InboundMessage::Disconnected {
        reason: reason.into(),
    });
}

fn restore_unsent_approval(state: &mut State, pending: &PendingRequest) {
    if state.disconnected.is_none() {
        if let Some(key) = &pending.server_request_key {
            state
                .server_requests
                .insert(key.clone(), ServerRequestState::Pending);
        }
    }
}

fn next_request_id() -> String {
    format!(
        "rocketx-native-{}",
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn not_sent(reason: &str) -> RpcFailure {
    RpcFailure::NotSent {
        reason: reason.into(),
    }
}

fn ensure_connected(state: &State) -> Result<(), RpcFailure> {
    match &state.disconnected {
        Some(reason) => Err(RpcFailure::NotSent {
            reason: reason.clone(),
        }),
        None => Ok(()),
    }
}

fn request_id_key(id: &Value) -> Option<String> {
    (id.is_string() || id.is_i64() || id.is_u64()).then(|| id.to_string())
}

fn encode_message(method: &str, message: Value) -> Result<Vec<u8>, RpcFailure> {
    if method.trim().is_empty() {
        return Err(RpcFailure::NotSent {
            reason: "empty method".into(),
        });
    }
    encode_frame(message)
}

fn encode_frame(message: Value) -> Result<Vec<u8>, RpcFailure> {
    let mut frame = serde_json::to_vec(&message).map_err(|error| RpcFailure::NotSent {
        reason: error.to_string(),
    })?;
    frame.push(b'\n');
    if frame.len() > MAX_CODEX_RPC_LINE_BYTES {
        return Err(RpcFailure::NotSent {
            reason: "message exceeds 2 MiB limit".into(),
        });
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, sync::Arc, thread};

    fn rpc() -> (
        Arc<NativeCodexRpc>,
        mpsc::Receiver<Value>,
        mpsc::Receiver<InboundMessage>,
    ) {
        let (writes_tx, writes_rx) = mpsc::channel();
        let (inbound_tx, inbound_rx) = mpsc::channel();
        let rpc = NativeCodexRpc::new(
            move |frame| {
                assert_eq!(frame.last(), Some(&b'\n'));
                writes_tx
                    .send(serde_json::from_slice(frame).unwrap())
                    .unwrap();
                Ok(())
            },
            move |event| {
                let _ = inbound_tx.send(event);
            },
        );
        (Arc::new(rpc), writes_rx, inbound_rx)
    }

    fn reply(rpc: &NativeCodexRpc, id: &Value, result: Value) {
        rpc.on_line(&json!({"id": id, "result": result}).to_string())
            .unwrap();
    }

    struct BlockedWriter {
        rpc: Arc<NativeCodexRpc>,
        entered: mpsc::Receiver<Value>,
        release: Sender<()>,
    }

    impl BlockedWriter {
        fn new() -> Self {
            let (entered_tx, entered) = mpsc::channel();
            let (release, release_rx) = mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let rpc = NativeCodexRpc::with_write_timeout(
                move |frame| {
                    let _ = entered_tx.send(serde_json::from_slice(frame).unwrap());
                    release_rx
                        .lock()
                        .unwrap()
                        .recv()
                        .map_err(|_| io::Error::other("test released"))?;
                    Ok(())
                },
                |_| {},
                Duration::from_millis(40),
            );
            Self {
                rpc: Arc::new(rpc),
                entered,
                release,
            }
        }
    }

    impl Drop for BlockedWriter {
        fn drop(&mut self) {
            self.rpc.disconnect("test releasing blocked writer");
            let _ = self.release.send(());
            self.rpc.join_writer();
        }
    }

    #[test]
    fn blocked_writer_returns_unknown_at_deadline_and_closes_connection() {
        let writer = BlockedWriter::new();
        let rpc = writer.rpc.clone();
        let started = Instant::now();
        let (result_tx, result_rx) = mpsc::channel();
        let request = thread::spawn(move || {
            result_tx
                .send(rpc.request("turn/start", json!({}), Duration::from_millis(60)))
                .unwrap();
        });
        let frame = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        reply(
            &writer.rpc,
            &frame["id"],
            json!("response before writer returned"),
        );
        assert!(matches!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err(RpcFailure::Unknown { .. })
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(matches!(
            writer.rpc.notify("initialized", json!({})),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(writer.rpc.state.lock().unwrap().pending.is_empty());
        request.join().unwrap();
        // Drop explicitly releases and joins the single blocked worker.
    }

    #[test]
    fn duplicate_response_cannot_replace_the_first_response_during_a_write() {
        let writer = BlockedWriter::new();
        let rpc = writer.rpc.clone();
        let request =
            thread::spawn(move || rpc.request("thread/read", json!({}), Duration::from_secs(2)));
        let frame = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        reply(&writer.rpc, &frame["id"], json!("first"));
        reply(&writer.rpc, &frame["id"], json!("duplicate"));
        assert!(!request.is_finished());
        writer.release.send(()).unwrap();
        assert_eq!(request.join().unwrap().unwrap(), json!("first"));
    }

    #[test]
    fn queued_request_expires_not_sent_and_is_never_written_later() {
        let writer = BlockedWriter::new();
        let rpc = writer.rpc.clone();
        let first = thread::spawn(move || rpc.request("first", json!({}), Duration::from_secs(2)));
        let active = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            writer
                .rpc
                .request("queued", json!({}), Duration::from_millis(40)),
            Err(RpcFailure::NotSent { .. })
        ));
        assert_eq!(writer.rpc.state.lock().unwrap().pending.len(), 1);
        reply(&writer.rpc, &active["id"], json!("first done"));
        writer.release.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap(), json!("first done"));
        writer.rpc.join_writer();
        assert!(writer.entered.try_recv().is_err());
    }

    #[test]
    fn blocked_notification_and_approval_are_bounded_and_never_replayed() {
        for approval in [false, true] {
            let writer = BlockedWriter::new();
            if approval {
                writer
                    .rpc
                    .on_line(
                        r#"{"id":"approval-blocked","method":"item/fileChange/requestApproval"}"#,
                    )
                    .unwrap();
            }
            let rpc = writer.rpc.clone();
            let (result_tx, result_rx) = mpsc::channel();
            let request = thread::spawn(move || {
                let result = if approval {
                    rpc.respond(&json!("approval-blocked"), json!({"decision":"decline"}))
                } else {
                    rpc.notify("initialized", json!({}))
                };
                result_tx.send(result).unwrap();
            });
            writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(matches!(
                result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                Err(RpcFailure::Unknown { .. })
            ));
            assert!(matches!(
                writer
                    .rpc
                    .respond(&json!("approval-blocked"), json!({"decision":"accept"})),
                Err(RpcFailure::NotSent { .. })
            ));
            request.join().unwrap();
        }
    }

    #[test]
    fn unsent_approval_reservation_is_restored_but_sent_approval_is_consumed() {
        let writer = BlockedWriter::new();
        let rpc = writer.rpc.clone();
        let first = thread::spawn(move || rpc.request("first", json!({}), Duration::from_secs(2)));
        let active = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let approval = r#"{"id":37,"method":"item/fileChange/requestApproval"}"#;
        writer.rpc.on_line(approval).unwrap();
        assert!(matches!(
            writer
                .rpc
                .respond(&json!(37), json!({"decision":"decline"})),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(
            writer.rpc.state.lock().unwrap().server_requests.get("37")
                == Some(&ServerRequestState::Pending)
        );
        reply(&writer.rpc, &active["id"], json!(true));
        writer.release.send(()).unwrap();
        first.join().unwrap().unwrap();
        let rpc = writer.rpc.clone();
        let response =
            thread::spawn(move || rpc.respond(&json!(37), json!({"decision":"decline"})));
        let approval_frame = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            approval_frame,
            json!({"id":37,"result":{"decision":"decline"}})
        );
        assert!(matches!(
            writer.rpc.respond(&json!(37), json!({"decision":"accept"})),
            Err(RpcFailure::NotSent { .. })
        ));
        writer.release.send(()).unwrap();
        response.join().unwrap().unwrap();
        assert_eq!(
            writer.rpc.on_line(approval),
            Err(ProtocolFailure::DuplicateServerRequest)
        );
    }

    #[test]
    fn full_writer_queue_rejects_without_consuming_an_approval() {
        let writer = BlockedWriter::new();
        let rpc = writer.rpc.clone();
        let first = thread::spawn(move || rpc.request("first", json!({}), Duration::from_secs(2)));
        let active = writer.entered.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..MAX_QUEUED_WRITES {
            writer
                .rpc
                .writes
                .try_send(Some(WriteJob {
                    id: next_request_id(),
                    frame: vec![],
                    started: Instant::now(),
                    timeout: Duration::from_secs(1),
                }))
                .unwrap();
        }
        writer
            .rpc
            .on_line(r#"{"id":38,"method":"item/fileChange/requestApproval"}"#)
            .unwrap();
        assert!(matches!(
            writer
                .rpc
                .respond(&json!(38), json!({"decision":"decline"})),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(
            writer.rpc.state.lock().unwrap().server_requests.get("38")
                == Some(&ServerRequestState::Pending)
        );
        reply(&writer.rpc, &active["id"], json!(true));
        writer.release.send(()).unwrap();
        first.join().unwrap().unwrap();
        writer.rpc.join_writer();
        assert!(writer.entered.try_recv().is_err());
    }

    #[test]
    fn concurrent_requests_correlate_out_of_order_responses() {
        let (rpc, writes, inbound) = rpc();
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let rpc = rpc.clone();
                thread::spawn(move || {
                    rpc.request(
                        "thread/read",
                        json!({"index": index}),
                        Duration::from_secs(2),
                    )
                })
            })
            .collect();
        let mut messages: Vec<_> = (0..8)
            .map(|_| writes.recv_timeout(Duration::from_secs(2)).unwrap())
            .collect();
        let ids: HashSet<_> = messages
            .iter()
            .map(|message| message["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 8);
        messages.reverse();
        for message in messages {
            reply(&rpc, &message["id"], message["params"].clone());
        }
        for (index, handle) in handles.into_iter().enumerate() {
            assert_eq!(handle.join().unwrap().unwrap(), json!({"index": index}));
        }
        assert!(inbound.try_recv().is_err());
    }

    #[test]
    fn server_request_with_matching_id_is_not_a_response() {
        let (rpc, writes, inbound) = rpc();
        let request_rpc = rpc.clone();
        let request = thread::spawn(move || {
            request_rpc.request("turn/start", json!({}), Duration::from_secs(2))
        });
        let message = writes.recv_timeout(Duration::from_secs(2)).unwrap();
        rpc.on_line(&json!({"id": message["id"], "method": "item/commandExecution/requestApproval", "params": {"command": "test"}}).to_string()).unwrap();
        assert!(matches!(
            inbound.recv().unwrap(),
            InboundMessage::ServerRequest { .. }
        ));
        assert!(!request.is_finished());
        assert!(writes.try_recv().is_err());
        reply(&rpc, &message["id"], json!({"turn": "original"}));
        assert_eq!(
            request.join().unwrap().unwrap(),
            json!({"turn": "original"})
        );
    }

    #[test]
    fn notifications_and_approvals_require_explicit_single_response() {
        let (rpc, writes, inbound) = rpc();
        assert!(matches!(
            rpc.respond(&json!(7), json!({"decision": "accept"})),
            Err(RpcFailure::NotSent { .. })
        ));
        rpc.on_line(r#"{"method":"turn/completed","params":{"turnId":"turn-1"}}"#)
            .unwrap();
        assert!(matches!(
            inbound.recv().unwrap(),
            InboundMessage::Notification { .. }
        ));
        rpc.on_line(r#"{"id":7,"method":"item/commandExecution/requestApproval","params":{}}"#)
            .unwrap();
        assert!(
            matches!(inbound.recv().unwrap(), InboundMessage::ServerRequest { id, .. } if id == json!(7))
        );
        assert!(writes.try_recv().is_err());
        rpc.respond(&json!(7), json!({"decision": "decline"}))
            .unwrap();
        assert_eq!(
            writes.recv().unwrap(),
            json!({"id":7,"result":{"decision":"decline"}})
        );
        assert!(matches!(
            rpc.respond(&json!(7), json!({"decision": "accept"})),
            Err(RpcFailure::NotSent { .. })
        ));
        rpc.notify("initialized", json!({})).unwrap();
        assert_eq!(
            writes.recv().unwrap(),
            json!({"method":"initialized","params":{}})
        );
    }

    #[test]
    fn timeout_and_late_response_cannot_complete_a_new_request() {
        let (rpc, writes, _) = rpc();
        assert!(matches!(
            rpc.request("thread/read", json!({}), Duration::from_millis(20)),
            Err(RpcFailure::Unknown { .. })
        ));
        let expired = writes.recv().unwrap();
        assert!(matches!(
            rpc.request("thread/read", json!({}), Duration::from_secs(1)),
            Err(RpcFailure::NotSent { .. })
        ));
        let (new_rpc, new_writes, _) = self::rpc();
        let request_rpc = new_rpc.clone();
        let request = thread::spawn(move || {
            request_rpc.request("thread/read", json!({}), Duration::from_secs(2))
        });
        let active = new_writes.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_ne!(expired["id"], active["id"]);
        reply(&rpc, &expired["id"], json!("late"));
        reply(&new_rpc, &expired["id"], json!("late on new connection"));
        assert!(!request.is_finished());
        reply(&new_rpc, &active["id"], json!("current"));
        assert_eq!(request.join().unwrap().unwrap(), json!("current"));
        assert!(rpc.state.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn disconnect_wakes_waiters_and_rejects_further_writes() {
        let (rpc, writes, inbound) = rpc();
        let requests: Vec<_> = (0..8)
            .map(|_| {
                let request_rpc = rpc.clone();
                thread::spawn(move || {
                    request_rpc.request("thread/read", json!({}), Duration::from_secs(30))
                })
            })
            .collect();
        for _ in 0..8 {
            writes.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        rpc.disconnect("child exited");
        for request in requests {
            assert!(matches!(
                request.join().unwrap(),
                Err(RpcFailure::Unknown { .. })
            ));
        }
        assert_eq!(
            inbound.recv().unwrap(),
            InboundMessage::Disconnected {
                reason: "child exited".into()
            }
        );
        rpc.disconnect("second observation");
        assert!(inbound.try_recv().is_err());
        assert!(matches!(
            rpc.request("thread/read", json!({}), Duration::from_secs(1)),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(matches!(
            rpc.notify("initialized", json!({})),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn request_disconnected_before_its_write_is_not_sent() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let rpc = Arc::new(NativeCodexRpc::new(
            move |_| {
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                Ok(())
            },
            |_| {},
        ));
        let first_rpc = rpc.clone();
        let first =
            thread::spawn(move || first_rpc.request("first", json!({}), Duration::from_secs(2)));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let request_rpc = rpc.clone();
        let request = thread::spawn(move || {
            request_rpc.request("turn/start", json!({}), Duration::from_secs(2))
        });
        let wait_started = Instant::now();
        while rpc.state.lock().unwrap().pending.len() < 2 {
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        }
        rpc.disconnect("closed before write");
        assert!(matches!(
            request.join().unwrap(),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(matches!(
            first.join().unwrap(),
            Err(RpcFailure::Unknown { .. })
        ));
        release_tx.send(()).unwrap();
        rpc.join_writer();
    }

    #[test]
    fn zero_timeout_never_writes_and_duplicate_server_request_never_dispatches_twice() {
        let (rpc, writes, inbound) = rpc();
        assert!(matches!(
            rpc.request("turn/start", json!({}), Duration::ZERO),
            Err(RpcFailure::NotSent { .. })
        ));
        let server_request = r#"{"id":"approval-1","method":"item/fileChange/requestApproval"}"#;
        rpc.on_line(server_request).unwrap();
        assert_eq!(
            rpc.on_line(server_request),
            Err(ProtocolFailure::DuplicateServerRequest)
        );
        assert!(matches!(
            inbound.recv().unwrap(),
            InboundMessage::ServerRequest { .. }
        ));
        assert!(inbound.try_recv().is_err());
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn partial_write_failure_is_unknown_and_is_never_retried() {
        let attempts = Arc::new(AtomicU64::new(0));
        let write_attempts = attempts.clone();
        let rpc = NativeCodexRpc::new(
            move |frame| {
                assert!(!frame[..frame.len() / 2].is_empty());
                write_attempts.fetch_add(1, Ordering::Relaxed);
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "partial write"))
            },
            |_| {},
        );
        assert!(matches!(
            rpc.request("turn/start", json!({}), Duration::from_secs(1)),
            Err(RpcFailure::Unknown { .. })
        ));
        assert!(matches!(
            rpc.request("turn/start", json!({}), Duration::from_secs(1)),
            Err(RpcFailure::NotSent { .. })
        ));
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
        assert!(rpc.state.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn original_error_is_rejected_without_losing_payload() {
        let (rpc, writes, _) = rpc();
        let request_rpc = rpc.clone();
        let request = thread::spawn(move || {
            request_rpc.request("turn/steer", json!({}), Duration::from_secs(2))
        });
        let message = writes.recv_timeout(Duration::from_secs(2)).unwrap();
        let error = json!({"code":-32602,"message":"turn id mismatch","data":{"turnId":"other"}});
        rpc.on_line(&json!({"id":message["id"],"error":error}).to_string())
            .unwrap();
        assert_eq!(request.join().unwrap(), Err(RpcFailure::Rejected { error }));
    }

    #[test]
    fn unsupported_server_request_gets_one_standard_error() {
        let (rpc, writes, inbound) = rpc();
        rpc.on_line(r#"{"id":"unsupported-1","method":"future/request"}"#)
            .unwrap();
        assert!(matches!(
            inbound.recv().unwrap(),
            InboundMessage::ServerRequest { .. }
        ));
        rpc.reject(&json!("unsupported-1"), -32601, "Unsupported request")
            .unwrap();
        assert_eq!(
            writes.recv_timeout(Duration::from_secs(1)).unwrap(),
            json!({
                "id":"unsupported-1", "error":{"code":-32601,"message":"Unsupported request"}
            })
        );
        assert!(matches!(
            rpc.respond(&json!("unsupported-1"), json!(true)),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn oversized_and_invalid_messages_do_not_write_or_dispatch() {
        let (rpc, writes, inbound) = rpc();
        assert!(matches!(
            rpc.request(
                "turn/start",
                json!("x".repeat(MAX_CODEX_RPC_LINE_BYTES)),
                Duration::from_secs(1)
            ),
            Err(RpcFailure::NotSent { .. })
        ));
        assert_eq!(
            rpc.on_line(&"x".repeat(MAX_CODEX_RPC_LINE_BYTES + 1)),
            Err(ProtocolFailure::MessageTooLarge)
        );
        assert_eq!(rpc.on_line("not json"), Err(ProtocolFailure::InvalidJson));
        assert_eq!(
            rpc.on_line(r#"{"id":1,"method":"test","result":true}"#),
            Err(ProtocolFailure::InvalidEnvelope)
        );
        assert_eq!(
            rpc.on_line(r#"{"id":1,"result":true,"error":{}}"#),
            Err(ProtocolFailure::InvalidEnvelope)
        );
        assert!(matches!(
            rpc.notify(" ", json!({})),
            Err(RpcFailure::NotSent { .. })
        ));
        assert!(writes.try_recv().is_err());
        assert!(inbound.try_recv().is_err());
    }
}
