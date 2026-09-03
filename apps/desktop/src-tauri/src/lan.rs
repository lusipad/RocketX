use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::native::lan::safe_file_name;
#[cfg(test)]
use crate::native::lan::transfer_paths;
use crate::native::lan_discovery::{
    announcement_from_identity, build_runtime_identity, now_ms, peer_key, random_nonce,
    trusted_map, LanAnnouncement, PeerKey, RuntimeIdentity,
};
#[allow(unused_imports)]
pub use crate::native::lan_discovery::{LanIdentityInfo, LanPeer, LanServiceInfo, TrustedDevice};
use crate::native::lan_discovery::{PEER_TTL_MS, SERVICE_TYPE, UDP_BROADCAST, UDP_GROUP, UDP_PORT};
#[cfg(test)]
use crate::native::lan_transfer::LanFileEvent;
pub use crate::native::lan_transfer::CHUNK_BYTES;
use crate::native::lan_transfer::{
    finish_file_transfer, hash_file, incoming_root, prepare_file_offer, write_file_chunk,
    IncomingTransfer, SharedTransfers,
};

#[allow(dead_code)]
pub fn server_fingerprint(server_url: &str) -> Result<String, String> {
    crate::native::lan_discovery::server_fingerprint(server_url)
}
#[cfg(test)]
use crate::native::lan_identity::validate_scope as validate_identity_scope;
#[cfg(test)]
use crate::native::lan_protocol::MAX_CONTROL_FRAME_BYTES;
use crate::native::lan_protocol::PROTOCOL_VERSION;
pub(crate) use crate::native::lan_protocol::{
    read_control_frame, sign_transcript, verify_transcript, write_control_frame, ControlFrame,
    HandshakePeer, HandshakeTranscript,
};
#[cfg(test)]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
#[cfg(test)]
use ed25519_dalek::SigningKey;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{Emitter, Manager};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const FILE_IO_TIMEOUT: Duration = Duration::from_secs(30);
const FILE_STREAMS: usize = 4;

#[derive(Default)]
pub struct LanKeychainLock(Mutex<()>);

#[derive(Default)]
pub struct LanRuntimeState(Mutex<Option<LanRuntime>>);

struct LanRuntime {
    stop: Arc<AtomicBool>,
    mdns: ServiceDaemon,
    service_fullname: String,
    peers: SharedPeers,
    trusted: SharedTrusted,
    identity: Arc<RuntimeIdentity>,
    threads: Vec<JoinHandle<()>>,
    connection_threads: SharedConnectionThreads,
}

type SharedPeers = Arc<RwLock<HashMap<PeerKey, LanPeer>>>;
type SharedTrusted = Arc<RwLock<HashMap<PeerKey, String>>>;

fn discovery_source_priority(source: &str) -> u8 {
    match source {
        // UDP 的来源地址就是对端实际发包的地址，优先于 mDNS 解析出的首个地址。
        "udp" => 2,
        "mdns" => 1,
        _ => 0,
    }
}

struct ConnectionThread {
    stream: TcpStream,
    handle: JoinHandle<()>,
}

type SharedConnectionThreads = Arc<Mutex<Vec<ConnectionThread>>>;

fn reap_finished_connection_threads(shared: &SharedConnectionThreads) {
    let finished = shared
        .lock()
        .map(|mut connections| {
            let mut finished = Vec::new();
            let mut active = Vec::with_capacity(connections.len());
            for connection in connections.drain(..) {
                if connection.handle.is_finished() {
                    finished.push(connection);
                } else {
                    active.push(connection);
                }
            }
            *connections = active;
            finished
        })
        .unwrap_or_default();
    for connection in finished {
        let _ = connection.handle.join();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LanMessageEvent {
    from_user_id: String,
    from_device_id: String,
    message_id: String,
    room_id: String,
    original_ts: i64,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LanProbeEvent {
    user_id: String,
    device_id: String,
    public_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanFileReceipt {
    pub message_id: String,
    pub file_name: String,
    pub size: u64,
    pub blake3: String,
}

/// 固定设备密钥是增强校验，不应阻断一次用户主动发起的 P2P 传输。
/// 没有固定记录时使用发现公告中的公钥完成本次签名握手；有记录时仍拒绝换钥。
fn verification_public_key(
    trusted: &SharedTrusted,
    peer: &HandshakePeer,
) -> Result<String, String> {
    let trusted = trusted
        .read()
        .map_err(|_| "LAN trust store is unavailable".to_string())?;
    match trusted.get(&peer_key(&peer.user_id, &peer.device_id)) {
        Some(pinned) if pinned != &peer.public_key => {
            Err("LAN peer broadcast key does not match the pinned device key".to_string())
        }
        Some(pinned) => Ok(pinned.clone()),
        None => Ok(peer.public_key.clone()),
    }
}

fn record_peer(
    announcement: LanAnnouncement,
    ip: Ipv4Addr,
    source: &str,
    local: &RuntimeIdentity,
    peers: &SharedPeers,
    trusted: &SharedTrusted,
) {
    if announcement.version != PROTOCOL_VERSION
        || announcement.server_fingerprint != local.server_fingerprint
        || announcement.device_id == local.peer.device_id
        || announcement.user_id.is_empty()
        || announcement.user_id.len() > 256
        || announcement.device_id.is_empty()
        || announcement.device_id.len() > 128
        || announcement.device_name.is_empty()
        || announcement.device_name.len() > 128
        || announcement.public_key.len() > 128
        || announcement.port == 0
        || ip.is_unspecified()
    {
        return;
    }
    let key = peer_key(&announcement.user_id, &announcement.device_id);
    let is_trusted = trusted
        .read()
        .ok()
        .and_then(|keys| keys.get(&key).cloned())
        .is_some_and(|pinned| pinned == announcement.public_key);
    if let Ok(mut peers) = peers.write() {
        let candidate = LanPeer {
            user_id: announcement.user_id,
            device_id: announcement.device_id,
            device_name: announcement.device_name,
            ip: ip.to_string(),
            port: announcement.port,
            public_key: announcement.public_key,
            trusted: is_trusted,
            source: source.to_string(),
            last_seen_ms: now_ms(),
        };
        match peers.get_mut(&key) {
            Some(existing)
                if discovery_source_priority(&existing.source)
                    > discovery_source_priority(&candidate.source) =>
            {
                // mDNS 可能先解析到 VPN/虚拟网卡地址；不要让它覆盖已由 UDP
                // 实际收到的可达地址，但仍刷新候选的存活时间。
                existing.last_seen_ms = candidate.last_seen_ms;
                existing.trusted = candidate.trusted;
            }
            _ => {
                peers.insert(key, candidate);
            }
        }
    }
}

fn read_hello(stream: &mut TcpStream) -> Result<(HandshakePeer, String), String> {
    match read_control_frame(stream)? {
        ControlFrame::Hello {
            version,
            peer,
            nonce,
        } if version == PROTOCOL_VERSION && !nonce.is_empty() && nonce.len() <= 128 => {
            Ok((peer, nonce))
        }
        ControlFrame::Hello { .. } => Err("LAN protocol version or nonce is invalid".to_string()),
        _ => Err("LAN handshake expected hello frame".to_string()),
    }
}

fn read_proof(stream: &mut TcpStream) -> Result<String, String> {
    match read_control_frame(stream)? {
        ControlFrame::Proof { signature } => Ok(signature),
        _ => Err("LAN handshake expected proof frame".to_string()),
    }
}

fn configure_stream(stream: &TcpStream) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .and_then(|_| stream.set_read_timeout(Some(IO_TIMEOUT)))
        .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .and_then(|_| stream.set_nodelay(true))
        .map_err(|error| format!("failed to configure LAN connection: {error}"))
}

fn accept_handshake(
    stream: &mut TcpStream,
    identity: &RuntimeIdentity,
    trusted: &SharedTrusted,
) -> Result<(HandshakePeer, bool), String> {
    let (initiator, initiator_nonce) = read_hello(stream)?;
    let responder_nonce = random_nonce()?;
    write_control_frame(
        stream,
        &ControlFrame::Hello {
            version: PROTOCOL_VERSION,
            peer: identity.peer.clone(),
            nonce: responder_nonce.clone(),
        },
    )?;
    let transcript = HandshakeTranscript {
        server_fingerprint: identity.server_fingerprint.clone(),
        initiator: initiator.clone(),
        responder: identity.peer.clone(),
        initiator_nonce,
        responder_nonce,
    };
    match read_control_frame(stream)? {
        ControlFrame::Proof { signature } => {
            let pinned = verification_public_key(trusted, &initiator)?;
            verify_transcript(&pinned, &transcript, &signature)?;
            write_control_frame(
                stream,
                &ControlFrame::Proof {
                    signature: sign_transcript(&identity.signing_key, &transcript),
                },
            )?;
            Ok((initiator, false))
        }
        ControlFrame::Probe {
            request_id,
            signature,
        } if !request_id.is_empty()
            && request_id.len() <= 128
            && !initiator.user_id.is_empty()
            && initiator.user_id.len() <= 256
            && !initiator.device_id.is_empty()
            && initiator.device_id.len() <= 128
            && initiator.device_id != identity.peer.device_id
            && initiator.public_key.len() <= 128 =>
        {
            // Probe 允许首次建立信任；已有固定设备仍必须匹配固定公钥。
            let pinned = trusted
                .read()
                .map_err(|_| "LAN trust store is unavailable".to_string())?
                .get(&peer_key(&initiator.user_id, &initiator.device_id))
                .cloned();
            if let Some(pinned) = pinned {
                if pinned != initiator.public_key {
                    return Err(
                        "LAN peer broadcast key does not match the pinned device key".to_string(),
                    );
                }
                verify_transcript(&pinned, &transcript, &signature)?;
            } else {
                verify_transcript(&initiator.public_key, &transcript, &signature)?;
            }
            write_control_frame(
                stream,
                &ControlFrame::ProbeAck {
                    request_id,
                    signature: sign_transcript(&identity.signing_key, &transcript),
                },
            )?;
            Ok((initiator, true))
        }
        _ => Err("LAN handshake expected proof or probe frame".to_string()),
    }
}

fn connect_handshake(
    stream: &mut TcpStream,
    identity: &RuntimeIdentity,
    expected: &LanPeer,
    trusted: &SharedTrusted,
) -> Result<(), String> {
    let initiator_nonce = random_nonce()?;
    write_control_frame(
        stream,
        &ControlFrame::Hello {
            version: PROTOCOL_VERSION,
            peer: identity.peer.clone(),
            nonce: initiator_nonce.clone(),
        },
    )?;
    let (responder, responder_nonce) = read_hello(stream)?;
    if responder.user_id != expected.user_id || responder.device_id != expected.device_id {
        return Err("LAN responder identity does not match the discovered peer".to_string());
    }
    if responder.public_key != expected.public_key {
        return Err("LAN responder key does not match the discovered peer".to_string());
    }
    let pinned = verification_public_key(trusted, &responder)?;
    let transcript = HandshakeTranscript {
        server_fingerprint: identity.server_fingerprint.clone(),
        initiator: identity.peer.clone(),
        responder,
        initiator_nonce,
        responder_nonce,
    };
    write_control_frame(
        stream,
        &ControlFrame::Proof {
            signature: sign_transcript(&identity.signing_key, &transcript),
        },
    )?;
    verify_transcript(&pinned, &transcript, &read_proof(stream)?)
}

fn connect_probe(
    stream: &mut TcpStream,
    identity: &RuntimeIdentity,
    expected: &LanPeer,
) -> Result<HandshakePeer, String> {
    let initiator_nonce = random_nonce()?;
    write_control_frame(
        stream,
        &ControlFrame::Hello {
            version: PROTOCOL_VERSION,
            peer: identity.peer.clone(),
            nonce: initiator_nonce.clone(),
        },
    )?;
    let (responder, responder_nonce) = read_hello(stream)?;
    if responder.user_id != expected.user_id || responder.device_id != expected.device_id {
        return Err("LAN responder identity does not match the discovered peer".to_string());
    }
    if responder.public_key != expected.public_key {
        return Err("LAN responder key does not match the discovered peer".to_string());
    }
    let transcript = HandshakeTranscript {
        server_fingerprint: identity.server_fingerprint.clone(),
        initiator: identity.peer.clone(),
        responder: responder.clone(),
        initiator_nonce,
        responder_nonce,
    };
    let request_id = random_nonce()?;
    write_control_frame(
        stream,
        &ControlFrame::Probe {
            request_id: request_id.clone(),
            signature: sign_transcript(&identity.signing_key, &transcript),
        },
    )?;
    match read_control_frame(stream)? {
        ControlFrame::ProbeAck {
            request_id: received,
            signature,
        } if received == request_id => {
            verify_transcript(&responder.public_key, &transcript, &signature)?;
            Ok(responder)
        }
        _ => Err("LAN peer returned an invalid probe acknowledgement".to_string()),
    }
}

fn open_udp_discovery_socket() -> Result<UdpSocket, String> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|error| format!("failed to create UDP discovery socket: {error}"))?;
    socket
        .set_reuse_address(true)
        .map_err(|error| format!("failed to configure UDP discovery socket: {error}"))?;
    socket
        .bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, UDP_PORT).into())
        .map_err(|error| format!("failed to bind UDP discovery socket: {error}"))?;
    let socket: UdpSocket = socket.into();
    socket
        .join_multicast_v4(&UDP_GROUP, &Ipv4Addr::UNSPECIFIED)
        .map_err(|error| format!("failed to join UDP discovery group: {error}"))?;
    socket
        .set_multicast_ttl_v4(1)
        .and_then(|_| socket.set_multicast_loop_v4(false))
        .and_then(|_| socket.set_broadcast(true))
        .and_then(|_| socket.set_read_timeout(Some(Duration::from_secs(1))))
        .map_err(|error| format!("failed to configure UDP discovery: {error}"))?;
    Ok(socket)
}

fn spawn_udp_discovery(
    announcement: LanAnnouncement,
    identity: Arc<RuntimeIdentity>,
    peers: SharedPeers,
    trusted: SharedTrusted,
    stop: Arc<AtomicBool>,
) -> Option<JoinHandle<()>> {
    let socket = open_udp_discovery_socket().ok()?;
    Some(thread::spawn(move || {
        let payload = match serde_json::to_vec(&announcement) {
            Ok(payload) => payload,
            Err(_) => return,
        };
        let multicast_destination = SocketAddrV4::new(UDP_GROUP, UDP_PORT);
        let broadcast_destination = SocketAddrV4::new(UDP_BROADCAST, UDP_PORT);
        let mut buffer = [0_u8; 8192];
        let mut next_announcement = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            if Instant::now() >= next_announcement {
                // 组播在 Windows 多网卡/防火墙环境下可能静默丢包；广播作为同网段兜底。
                let _ = socket.send_to(&payload, multicast_destination);
                let _ = socket.send_to(&payload, broadcast_destination);
                next_announcement = Instant::now() + Duration::from_secs(3);
            }
            match socket.recv_from(&mut buffer) {
                Ok((length, SocketAddr::V4(source))) => {
                    if let Ok(announcement) =
                        serde_json::from_slice::<LanAnnouncement>(&buffer[..length])
                    {
                        record_peer(
                            announcement,
                            *source.ip(),
                            "udp",
                            &identity,
                            &peers,
                            &trusted,
                        );
                    }
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
    }))
}

fn spawn_mdns_browser(
    receiver: mdns_sd::Receiver<ServiceEvent>,
    identity: Arc<RuntimeIdentity>,
    peers: SharedPeers,
    trusted: SharedTrusted,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) else {
                continue;
            };
            let ServiceEvent::ServiceResolved(info) = event else {
                continue;
            };
            let Some(ip) = info
                .get_addresses_v4()
                .into_iter()
                .find(|ip| !ip.is_unspecified())
            else {
                continue;
            };
            let Some(version) = info
                .get_property_val_str("v")
                .and_then(|value| value.parse::<u16>().ok())
            else {
                continue;
            };
            let Some(server_fingerprint) = info.get_property_val_str("server") else {
                continue;
            };
            let Some(user_id) = info.get_property_val_str("user") else {
                continue;
            };
            let Some(device_id) = info.get_property_val_str("device") else {
                continue;
            };
            let Some(device_name) = info.get_property_val_str("name") else {
                continue;
            };
            let Some(public_key) = info.get_property_val_str("key") else {
                continue;
            };
            record_peer(
                LanAnnouncement {
                    version,
                    server_fingerprint: server_fingerprint.to_string(),
                    user_id: user_id.to_string(),
                    device_id: device_id.to_string(),
                    device_name: device_name.to_string(),
                    port: info.get_port(),
                    public_key: public_key.to_string(),
                },
                ip,
                "mdns",
                &identity,
                &peers,
                &trusted,
            );
        }
    })
}

fn handle_incoming(
    app: tauri::AppHandle,
    mut stream: TcpStream,
    identity: Arc<RuntimeIdentity>,
    trusted: SharedTrusted,
    transfers: SharedTransfers,
) -> Result<(), String> {
    configure_stream(&stream)?;
    stream
        .set_read_timeout(Some(FILE_IO_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(FILE_IO_TIMEOUT)))
        .map_err(|error| format!("failed to configure LAN file connection: {error}"))?;
    let (peer, probed) = accept_handshake(&mut stream, &identity, &trusted)?;
    if probed {
        app.emit(
            "rocketx://lan-peer-probed",
            LanProbeEvent {
                user_id: peer.user_id,
                device_id: peer.device_id,
                public_key: peer.public_key,
            },
        )
        .map_err(|error| format!("failed to deliver LAN probe event: {error}"))?;
        return Ok(());
    }
    let root = incoming_root(&app)?;
    let mut processed = false;
    loop {
        let frame = match read_control_frame(&mut stream) {
            Ok(frame) => frame,
            Err(_) if processed => return Ok(()),
            Err(error) => return Err(error),
        };
        processed = true;
        match frame {
            ControlFrame::Chat {
                message_id,
                room_id,
                original_ts,
                text,
            } if !message_id.is_empty()
                && message_id.len() <= 256
                && !room_id.is_empty()
                && room_id.len() <= 256
                && original_ts > 0
                && text.len() <= 48 * 1024 =>
            {
                app.emit(
                    "rocketx://lan-message",
                    LanMessageEvent {
                        from_user_id: peer.user_id.clone(),
                        from_device_id: peer.device_id.clone(),
                        message_id: message_id.clone(),
                        room_id,
                        original_ts,
                        text,
                    },
                )
                .map_err(|error| format!("failed to deliver LAN message event: {error}"))?;
                write_control_frame(&mut stream, &ControlFrame::Ack { id: message_id })?;
                return Ok(());
            }
            ControlFrame::FileOffer {
                transfer_id,
                message_id,
                room_id,
                original_ts,
                file_name,
                size,
                chunk_bytes,
                chunk_count,
                blake3,
            } => {
                let indexes = prepare_file_offer(
                    &root,
                    &peer,
                    &transfers,
                    IncomingTransfer {
                        version: PROTOCOL_VERSION,
                        transfer_id: transfer_id.clone(),
                        from_user_id: peer.user_id.clone(),
                        from_device_id: peer.device_id.clone(),
                        message_id,
                        room_id,
                        original_ts,
                        file_name,
                        size,
                        chunk_bytes,
                        chunk_count,
                        blake3,
                        received: Vec::new(),
                    },
                )?;
                write_control_frame(
                    &mut stream,
                    &ControlFrame::MissingChunks {
                        transfer_id,
                        indexes,
                    },
                )?;
                return Ok(());
            }
            ControlFrame::FileChunk {
                transfer_id,
                index,
                length,
                blake3,
            } => {
                if length == 0 || length > CHUNK_BYTES {
                    return Err("LAN file chunk length is invalid".to_string());
                }
                let mut bytes = vec![0_u8; length as usize];
                stream
                    .read_exact(&mut bytes)
                    .map_err(|error| format!("failed to read LAN file chunk: {error}"))?;
                write_file_chunk(
                    &root,
                    &peer,
                    &transfers,
                    &transfer_id,
                    index,
                    &blake3,
                    &bytes,
                )?;
                write_control_frame(
                    &mut stream,
                    &ControlFrame::Ack {
                        id: format!("{transfer_id}:{index}"),
                    },
                )?;
            }
            ControlFrame::FileComplete { transfer_id } => {
                let event = finish_file_transfer(&root, &peer, &transfers, &transfer_id)?;
                app.emit("rocketx://lan-file", event)
                    .map_err(|error| format!("failed to deliver LAN file event: {error}"))?;
                write_control_frame(&mut stream, &ControlFrame::Ack { id: transfer_id })?;
                return Ok(());
            }
            ControlFrame::Chat { .. } => {
                return Err("LAN chat message failed validation".to_string());
            }
            other => {
                let _ = write_control_frame(
                    &mut stream,
                    &ControlFrame::Error {
                        code: "unsupported_command".to_string(),
                        message: format!("unsupported LAN frame: {other:?}"),
                    },
                );
                return Err("unsupported LAN command".to_string());
            }
        }
    }
}

fn spawn_tcp_listener(
    app: tauri::AppHandle,
    listener: TcpListener,
    identity: Arc<RuntimeIdentity>,
    trusted: SharedTrusted,
    transfers: SharedTransfers,
    stop: Arc<AtomicBool>,
    connection_threads: SharedConnectionThreads,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            reap_finished_connection_threads(&connection_threads);
            match listener.accept() {
                Ok((stream, _)) => {
                    let shutdown_stream = match stream.try_clone() {
                        Ok(stream) => stream,
                        Err(error) => {
                            log::warn!("LAN connection cannot be tracked for shutdown: {error}");
                            continue;
                        }
                    };
                    let app = app.clone();
                    let identity = identity.clone();
                    let trusted = trusted.clone();
                    let transfers = transfers.clone();
                    let connection = thread::spawn(move || {
                        if let Err(error) =
                            handle_incoming(app, stream, identity, trusted, transfers)
                        {
                            log::warn!("LAN connection rejected: {error}");
                        }
                    });
                    if let Ok(mut threads) = connection_threads.lock() {
                        threads.push(ConnectionThread {
                            stream: shutdown_stream,
                            handle: connection,
                        });
                    } else {
                        let _ = shutdown_stream.shutdown(Shutdown::Both);
                        let _ = connection.join();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    log::warn!("LAN listener stopped: {error}");
                    break;
                }
            }
        }
    })
}

#[tauri::command]
pub fn lan_service_start(
    app: tauri::AppHandle,
    keychain: tauri::State<'_, LanKeychainLock>,
    runtime: tauri::State<'_, LanRuntimeState>,
    server_url: String,
    user_id: String,
    device_name: String,
    trusted_devices: Vec<TrustedDevice>,
) -> Result<LanServiceInfo, String> {
    let mut runtime_guard = runtime
        .0
        .lock()
        .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
    if runtime_guard.is_some() {
        return Err("LAN service is already running".to_string());
    }
    let _keychain_guard = keychain
        .0
        .lock()
        .map_err(|_| "LAN identity keychain lock is unavailable".to_string())?;
    let (identity, identity_info) = build_runtime_identity(&server_url, &user_id, &device_name)?;
    let trusted = Arc::new(RwLock::new(trusted_map(trusted_devices)?));
    let peers = Arc::new(RwLock::new(HashMap::new()));
    let transfers = Arc::new(Mutex::new(HashMap::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let connection_threads = Arc::new(Mutex::new(Vec::new()));

    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("failed to bind LAN listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read LAN listener address: {error}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure LAN listener: {error}"))?;

    let announcement = announcement_from_identity(&identity, port);
    let mdns = ServiceDaemon::new().map_err(|error| format!("failed to start mDNS: {error}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|error| format!("failed to browse mDNS services: {error}"))?;
    let version = announcement.version.to_string();
    let properties = [
        ("v", version.as_str()),
        ("server", announcement.server_fingerprint.as_str()),
        ("user", announcement.user_id.as_str()),
        ("device", announcement.device_id.as_str()),
        ("name", announcement.device_name.as_str()),
        ("key", announcement.public_key.as_str()),
    ];
    let instance = format!(
        "rocketx-{}-{}",
        &blake3::hash(user_id.as_bytes()).to_hex()[..10],
        &blake3::hash(announcement.device_id.as_bytes()).to_hex()[..10]
    );
    let hostname = format!("{instance}.local.");
    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &hostname,
        "",
        port,
        &properties[..],
    )
    .map_err(|error| format!("failed to build mDNS service: {error}"))?
    .enable_addr_auto();
    let service_fullname = service.get_fullname().to_string();
    mdns.register(service)
        .map_err(|error| format!("failed to register mDNS service: {error}"))?;

    let mut threads = vec![
        spawn_tcp_listener(
            app,
            listener,
            identity.clone(),
            trusted.clone(),
            transfers,
            stop.clone(),
            connection_threads.clone(),
        ),
        spawn_mdns_browser(
            receiver,
            identity.clone(),
            peers.clone(),
            trusted.clone(),
            stop.clone(),
        ),
    ];
    if let Some(thread) = spawn_udp_discovery(
        announcement,
        identity.clone(),
        peers.clone(),
        trusted.clone(),
        stop.clone(),
    ) {
        threads.push(thread);
    }

    *runtime_guard = Some(LanRuntime {
        stop,
        mdns,
        service_fullname,
        peers,
        trusted,
        identity,
        threads,
        connection_threads,
    });
    Ok(LanServiceInfo {
        identity: identity_info,
        port,
    })
}

#[tauri::command]
pub fn lan_service_stop(runtime: tauri::State<'_, LanRuntimeState>) -> Result<(), String> {
    let current = runtime
        .0
        .lock()
        .map_err(|_| "LAN runtime lock is unavailable".to_string())?
        .take();
    let Some(current) = current else {
        return Ok(());
    };
    stop_runtime(current);
    Ok(())
}

fn stop_runtime(current: LanRuntime) {
    current.stop.store(true, Ordering::Relaxed);
    let _ = current.mdns.unregister(&current.service_fullname);
    let _ = current.mdns.shutdown();
    for thread in current.threads {
        let _ = thread.join();
    }
    let connections = current
        .connection_threads
        .lock()
        .map(|mut connections| connections.drain(..).collect::<Vec<_>>())
        .unwrap_or_default();
    for connection in connections {
        let _ = connection.stream.shutdown(Shutdown::Both);
        let _ = connection.handle.join();
    }
}

pub fn shutdown(app: &tauri::AppHandle) {
    let current = app
        .state::<LanRuntimeState>()
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.take());
    if let Some(current) = current {
        stop_runtime(current);
    }
}

#[tauri::command]
pub fn lan_trust_replace(
    runtime: tauri::State<'_, LanRuntimeState>,
    trusted_devices: Vec<TrustedDevice>,
) -> Result<(), String> {
    let trusted_devices = trusted_map(trusted_devices)?;
    let runtime = runtime
        .0
        .lock()
        .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
    let current = runtime
        .as_ref()
        .ok_or_else(|| "LAN service is not running".to_string())?;
    *current
        .trusted
        .write()
        .map_err(|_| "LAN trust store is unavailable".to_string())? = trusted_devices;
    let trusted = current
        .trusted
        .read()
        .map_err(|_| "LAN trust store is unavailable".to_string())?;
    let mut peers = current
        .peers
        .write()
        .map_err(|_| "LAN peer store is unavailable".to_string())?;
    for peer in peers.values_mut() {
        peer.trusted = trusted
            .get(&peer_key(&peer.user_id, &peer.device_id))
            .is_some_and(|key| key == &peer.public_key);
    }
    Ok(())
}

#[tauri::command]
pub fn lan_peers(runtime: tauri::State<'_, LanRuntimeState>) -> Result<Vec<LanPeer>, String> {
    let runtime = runtime
        .0
        .lock()
        .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
    let Some(current) = runtime.as_ref() else {
        return Ok(Vec::new());
    };
    let cutoff = now_ms().saturating_sub(PEER_TTL_MS);
    let mut peers = current
        .peers
        .write()
        .map_err(|_| "LAN peer store is unavailable".to_string())?;
    peers.retain(|_, peer| peer.last_seen_ms >= cutoff);
    let mut peers = peers.values().cloned().collect::<Vec<_>>();
    peers.sort_by(|left, right| {
        right
            .trusted
            .cmp(&left.trusted)
            .then_with(|| left.device_name.cmp(&right.device_name))
    });
    Ok(peers)
}

#[tauri::command]
pub async fn lan_probe_peer(
    runtime: tauri::State<'_, LanRuntimeState>,
    user_id: String,
    device_id: Option<String>,
) -> Result<TrustedDevice, String> {
    let (peer, identity) = {
        let runtime = runtime
            .0
            .lock()
            .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
        let current = runtime
            .as_ref()
            .ok_or_else(|| "LAN service is not running".to_string())?;
        let peers = current
            .peers
            .read()
            .map_err(|_| "LAN peer store is unavailable".to_string())?;
        let peer = peers
            .values()
            .filter(|peer| {
                peer.user_id == user_id && device_id.as_ref().is_none_or(|id| id == &peer.device_id)
            })
            .max_by_key(|peer| peer.last_seen_ms)
            .cloned()
            .ok_or_else(|| "no LAN peer is online for this user".to_string())?;
        (peer, current.identity.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        let address: SocketAddr = format!("{}:{}", peer.ip, peer.port)
            .parse()
            .map_err(|_| "LAN peer address is invalid".to_string())?;
        let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|error| format!("failed to connect LAN peer: {error}"))?;
        configure_stream(&stream)?;
        let responder = connect_probe(&mut stream, &identity, &peer)?;
        Ok(TrustedDevice {
            user_id: responder.user_id,
            device_id: responder.device_id,
            public_key: responder.public_key,
        })
    })
    .await
    .map_err(|error| format!("LAN probe task failed: {error}"))?
}

#[tauri::command]
pub async fn lan_send_chat(
    runtime: tauri::State<'_, LanRuntimeState>,
    user_id: String,
    device_id: Option<String>,
    message_id: String,
    room_id: String,
    original_ts: i64,
    text: String,
) -> Result<(), String> {
    if message_id.is_empty()
        || message_id.len() > 256
        || room_id.is_empty()
        || room_id.len() > 256
        || original_ts <= 0
        || text.is_empty()
        || text.len() > 48 * 1024
    {
        return Err("LAN chat message is invalid".to_string());
    }
    let (peer, identity, trusted) = {
        let runtime = runtime
            .0
            .lock()
            .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
        let current = runtime
            .as_ref()
            .ok_or_else(|| "LAN service is not running".to_string())?;
        let peers = current
            .peers
            .read()
            .map_err(|_| "LAN peer store is unavailable".to_string())?;
        let peer = peers
            .values()
            .filter(|peer| {
                peer.user_id == user_id
                    && peer.trusted
                    && device_id.as_ref().is_none_or(|id| id == &peer.device_id)
            })
            .max_by_key(|peer| peer.last_seen_ms)
            .cloned()
            .ok_or_else(|| "no trusted LAN peer is online for this user".to_string())?;
        (peer, current.identity.clone(), current.trusted.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        send_chat_to_peer(
            &peer,
            &identity,
            &trusted,
            message_id,
            room_id,
            original_ts,
            text,
        )
    })
    .await
    .map_err(|error| format!("LAN send task failed: {error}"))?
}

fn send_chat_to_peer(
    peer: &LanPeer,
    identity: &RuntimeIdentity,
    trusted: &SharedTrusted,
    message_id: String,
    room_id: String,
    original_ts: i64,
    text: String,
) -> Result<(), String> {
    let address: SocketAddr = format!("{}:{}", peer.ip, peer.port)
        .parse()
        .map_err(|_| "LAN peer address is invalid".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| format!("failed to connect LAN peer: {error}"))?;
    configure_stream(&stream)?;
    connect_handshake(&mut stream, identity, peer, trusted)?;
    write_control_frame(
        &mut stream,
        &ControlFrame::Chat {
            message_id: message_id.clone(),
            room_id,
            original_ts,
            text,
        },
    )?;
    match read_control_frame(&mut stream)? {
        ControlFrame::Ack { id } if id == message_id => Ok(()),
        ControlFrame::Error { code, message } => {
            Err(format!("LAN peer rejected message ({code}): {message}"))
        }
        _ => Err("LAN peer returned an invalid acknowledgement".to_string()),
    }
}

fn connect_to_peer(
    peer: &LanPeer,
    identity: &RuntimeIdentity,
    trusted: &SharedTrusted,
) -> Result<TcpStream, String> {
    let address: SocketAddr = format!("{}:{}", peer.ip, peer.port)
        .parse()
        .map_err(|_| "LAN peer address is invalid".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| format!("failed to connect LAN peer: {error}"))?;
    configure_stream(&stream)?;
    stream
        .set_read_timeout(Some(FILE_IO_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(FILE_IO_TIMEOUT)))
        .map_err(|error| format!("failed to configure LAN file connection: {error}"))?;
    connect_handshake(&mut stream, identity, peer, trusted)?;
    Ok(stream)
}

fn send_file_chunks(
    path: &Path,
    indexes: &[u64],
    transfer_id: &str,
    peer: &LanPeer,
    identity: &RuntimeIdentity,
    trusted: &SharedTrusted,
    size: u64,
) -> Result<(), String> {
    if indexes.is_empty() {
        return Ok(());
    }
    let mut stream = connect_to_peer(peer, identity, trusted)?;
    let mut file =
        File::open(path).map_err(|error| format!("failed to open LAN source file: {error}"))?;
    for index in indexes {
        let offset = index
            .checked_mul(CHUNK_BYTES as u64)
            .ok_or_else(|| "LAN file offset overflowed".to_string())?;
        if offset >= size {
            return Err("LAN peer requested an invalid file chunk".to_string());
        }
        let length = (size - offset).min(CHUNK_BYTES as u64) as usize;
        let mut bytes = vec![0_u8; length];
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|error| format!("failed to read LAN source chunk: {error}"))?;
        write_control_frame(
            &mut stream,
            &ControlFrame::FileChunk {
                transfer_id: transfer_id.to_string(),
                index: *index,
                length: length as u32,
                blake3: blake3::hash(&bytes).to_hex().to_string(),
            },
        )?;
        stream
            .write_all(&bytes)
            .map_err(|error| format!("failed to send LAN file chunk: {error}"))?;
        match read_control_frame(&mut stream)? {
            ControlFrame::Ack { id } if id == format!("{transfer_id}:{index}") => {}
            ControlFrame::Error { code, message } => {
                return Err(format!("LAN peer rejected file chunk ({code}): {message}"));
            }
            _ => return Err("LAN peer returned an invalid chunk acknowledgement".to_string()),
        }
    }
    Ok(())
}

fn send_file_to_peer(
    path: PathBuf,
    peer: LanPeer,
    identity: Arc<RuntimeIdentity>,
    trusted: SharedTrusted,
    message_id: String,
    room_id: String,
    original_ts: i64,
) -> Result<LanFileReceipt, String> {
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to inspect LAN source file: {error}"))?;
    if !metadata.is_file() {
        return Err("LAN source path is not a file".to_string());
    }
    let size = metadata.len();
    let chunk_count = size.div_ceil(CHUNK_BYTES as u64);
    if chunk_count > 8192 {
        return Err("LAN source file exceeds the 8 GiB transfer limit".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "LAN source file name is invalid".to_string())?
        .to_string();
    safe_file_name(&file_name)?;
    let file_hash = hash_file(&path)?;
    let transfer_id = blake3::hash(
        format!(
            "{}\0{}\0{}\0{}",
            message_id, file_hash, peer.user_id, peer.device_id
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string();
    let mut offer = connect_to_peer(&peer, &identity, &trusted)?;
    write_control_frame(
        &mut offer,
        &ControlFrame::FileOffer {
            transfer_id: transfer_id.clone(),
            message_id: message_id.clone(),
            room_id,
            original_ts,
            file_name: file_name.clone(),
            size,
            chunk_bytes: CHUNK_BYTES,
            chunk_count,
            blake3: file_hash.clone(),
        },
    )?;
    let missing = match read_control_frame(&mut offer)? {
        ControlFrame::MissingChunks {
            transfer_id: response_id,
            indexes,
        } if response_id == transfer_id => indexes,
        ControlFrame::Error { code, message } => {
            return Err(format!("LAN peer rejected file offer ({code}): {message}"));
        }
        _ => return Err("LAN peer returned an invalid file resume plan".to_string()),
    };
    if missing.iter().any(|index| *index >= chunk_count) {
        return Err("LAN peer requested an invalid file chunk".to_string());
    }
    let mut buckets = vec![Vec::<u64>::new(); FILE_STREAMS.min(missing.len().max(1))];
    for (position, index) in missing.into_iter().enumerate() {
        let bucket_count = buckets.len();
        buckets[position % bucket_count].push(index);
    }
    let handles = buckets
        .into_iter()
        .filter(|indexes| !indexes.is_empty())
        .map(|indexes| {
            let path = path.clone();
            let peer = peer.clone();
            let identity = identity.clone();
            let trusted = trusted.clone();
            let transfer_id = transfer_id.clone();
            thread::spawn(move || {
                send_file_chunks(
                    &path,
                    &indexes,
                    &transfer_id,
                    &peer,
                    &identity,
                    &trusted,
                    size,
                )
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle
            .join()
            .map_err(|_| "LAN file stream panicked".to_string())??;
    }
    let mut complete = connect_to_peer(&peer, &identity, &trusted)?;
    write_control_frame(
        &mut complete,
        &ControlFrame::FileComplete {
            transfer_id: transfer_id.clone(),
        },
    )?;
    match read_control_frame(&mut complete)? {
        ControlFrame::Ack { id } if id == transfer_id => Ok(LanFileReceipt {
            message_id,
            file_name,
            size,
            blake3: file_hash,
        }),
        ControlFrame::Error { code, message } => Err(format!(
            "LAN peer rejected completed file ({code}): {message}"
        )),
        _ => Err("LAN peer returned an invalid file completion acknowledgement".to_string()),
    }
}

#[tauri::command]
pub async fn lan_send_file(
    runtime: tauri::State<'_, LanRuntimeState>,
    user_id: String,
    device_id: Option<String>,
    path: String,
    message_id: String,
    room_id: String,
    original_ts: i64,
) -> Result<LanFileReceipt, String> {
    if user_id.is_empty()
        || user_id.len() > 256
        || message_id.is_empty()
        || message_id.len() > 256
        || room_id.is_empty()
        || room_id.len() > 256
        || original_ts <= 0
    {
        return Err("LAN file request is invalid".to_string());
    }
    let path = fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve LAN source file: {error}"))?;
    let (peer, identity, trusted) = {
        let runtime = runtime
            .0
            .lock()
            .map_err(|_| "LAN runtime lock is unavailable".to_string())?;
        let current = runtime
            .as_ref()
            .ok_or_else(|| "LAN service is not running".to_string())?;
        let peers = current
            .peers
            .read()
            .map_err(|_| "LAN peer store is unavailable".to_string())?;
        let peer = peers
            .values()
            .filter(|peer| {
                peer.user_id == user_id && device_id.as_ref().is_none_or(|id| id == &peer.device_id)
            })
            .max_by_key(|peer| peer.last_seen_ms)
            .cloned()
            .ok_or_else(|| "no LAN peer is online for this user".to_string())?;
        (peer, current.identity.clone(), current.trusted.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        send_file_to_peer(
            path,
            peer,
            identity,
            trusted,
            message_id,
            room_id,
            original_ts,
        )
    })
    .await
    .map_err(|error| format!("LAN file task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::mpsc;

    use super::*;

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn peer(user_id: &str, device_id: &str, key: &SigningKey) -> HandshakePeer {
        HandshakePeer {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
        }
    }

    fn transcript(alice: &SigningKey, bob: &SigningKey) -> HandshakeTranscript {
        HandshakeTranscript {
            server_fingerprint: "server-a".to_string(),
            initiator: peer("alice", "alice-device", alice),
            responder: peer("bob", "bob-device", bob),
            initiator_nonce: "nonce-a".to_string(),
            responder_nonce: "nonce-b".to_string(),
        }
    }

    fn runtime_identity(user_id: &str, device_id: &str, key: SigningKey) -> RuntimeIdentity {
        RuntimeIdentity {
            peer: peer(user_id, device_id, &key),
            device_name: device_id.to_string(),
            server_fingerprint: "server-a".to_string(),
            signing_key: key,
        }
    }

    fn trust(identity: &RuntimeIdentity) -> SharedTrusted {
        Arc::new(RwLock::new(HashMap::from([(
            peer_key(&identity.peer.user_id, &identity.peer.device_id),
            identity.peer.public_key.clone(),
        )])))
    }

    fn handle_test_file_connection(
        mut stream: TcpStream,
        identity: Arc<RuntimeIdentity>,
        trusted: SharedTrusted,
        transfers: SharedTransfers,
        root: PathBuf,
        completed: mpsc::Sender<LanFileEvent>,
        stop: Arc<AtomicBool>,
    ) -> Result<(), String> {
        configure_stream(&stream)?;
        let (peer, probed) = accept_handshake(&mut stream, &identity, &trusted)?;
        if probed {
            return Ok(());
        }
        loop {
            match read_control_frame(&mut stream) {
                Ok(ControlFrame::FileOffer {
                    transfer_id,
                    message_id,
                    room_id,
                    original_ts,
                    file_name,
                    size,
                    chunk_bytes,
                    chunk_count,
                    blake3,
                }) => {
                    let indexes = prepare_file_offer(
                        &root,
                        &peer,
                        &transfers,
                        IncomingTransfer {
                            version: PROTOCOL_VERSION,
                            transfer_id: transfer_id.clone(),
                            from_user_id: peer.user_id.clone(),
                            from_device_id: peer.device_id.clone(),
                            message_id,
                            room_id,
                            original_ts,
                            file_name,
                            size,
                            chunk_bytes,
                            chunk_count,
                            blake3,
                            received: Vec::new(),
                        },
                    )?;
                    write_control_frame(
                        &mut stream,
                        &ControlFrame::MissingChunks {
                            transfer_id,
                            indexes,
                        },
                    )?;
                    return Ok(());
                }
                Ok(ControlFrame::FileChunk {
                    transfer_id,
                    index,
                    length,
                    blake3,
                }) => {
                    let mut bytes = vec![0_u8; length as usize];
                    stream
                        .read_exact(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    write_file_chunk(
                        &root,
                        &peer,
                        &transfers,
                        &transfer_id,
                        index,
                        &blake3,
                        &bytes,
                    )?;
                    write_control_frame(
                        &mut stream,
                        &ControlFrame::Ack {
                            id: format!("{transfer_id}:{index}"),
                        },
                    )?;
                }
                Ok(ControlFrame::FileComplete { transfer_id }) => {
                    let event = finish_file_transfer(&root, &peer, &transfers, &transfer_id)?;
                    completed.send(event).map_err(|error| error.to_string())?;
                    write_control_frame(&mut stream, &ControlFrame::Ack { id: transfer_id })?;
                    stop.store(true, Ordering::Relaxed);
                    return Ok(());
                }
                Ok(other) => return Err(format!("unexpected test frame: {other:?}")),
                Err(_) => return Ok(()),
            }
        }
    }

    #[test]
    fn strict_signature_accepts_pinned_peer() {
        let alice = signing_key(7);
        let bob = signing_key(9);
        let transcript = transcript(&alice, &bob);
        let signature = sign_transcript(&alice, &transcript);
        verify_transcript(&transcript.initiator.public_key, &transcript, &signature).unwrap();
    }

    #[test]
    fn spoofed_user_with_unpinned_key_is_rejected() {
        let alice = signing_key(7);
        let bob = signing_key(9);
        let attacker = signing_key(11);
        let transcript = transcript(&attacker, &bob);
        let signature = sign_transcript(&attacker, &transcript);
        let pinned_alice = URL_SAFE_NO_PAD.encode(alice.verifying_key().to_bytes());
        assert!(verify_transcript(&pinned_alice, &transcript, &signature).is_err());
    }

    #[test]
    fn replayed_signature_fails_with_new_nonce() {
        let alice = signing_key(7);
        let bob = signing_key(9);
        let original = transcript(&alice, &bob);
        let signature = sign_transcript(&alice, &original);
        let mut replay = original.clone();
        replay.responder_nonce = "fresh-nonce".to_string();
        assert!(verify_transcript(&original.initiator.public_key, &replay, &signature).is_err());
    }

    #[test]
    fn udp_discovery_address_is_not_overwritten_by_mdns() {
        let local = runtime_identity("local", "local-device", signing_key(5));
        let peers = Arc::new(RwLock::new(HashMap::new()));
        let trusted = Arc::new(RwLock::new(HashMap::new()));
        let announcement = LanAnnouncement {
            version: PROTOCOL_VERSION,
            server_fingerprint: local.server_fingerprint.clone(),
            user_id: "bob".to_string(),
            device_id: "bob-device".to_string(),
            device_name: "Bob".to_string(),
            port: 45826,
            public_key: peer("bob", "bob-device", &signing_key(9)).public_key,
        };

        record_peer(
            announcement.clone(),
            Ipv4Addr::new(192, 168, 1, 20),
            "udp",
            &local,
            &peers,
            &trusted,
        );
        record_peer(
            announcement,
            Ipv4Addr::new(172, 20, 0, 2),
            "mdns",
            &local,
            &peers,
            &trusted,
        );

        let peer = peers.read().unwrap().values().next().cloned().unwrap();
        assert_eq!(peer.ip, "192.168.1.20");
        assert_eq!(peer.source, "udp");
    }

    #[test]
    fn tcp_handshake_authenticates_both_pinned_devices() {
        let alice = runtime_identity("alice", "alice-device", signing_key(7));
        let bob = runtime_identity("bob", "bob-device", signing_key(9));
        let alice_trust = trust(&bob);
        let bob_trust = trust(&alice);
        let expected_bob = LanPeer {
            user_id: bob.peer.user_id.clone(),
            device_id: bob.peer.device_id.clone(),
            device_name: bob.device_name.clone(),
            ip: Ipv4Addr::LOCALHOST.to_string(),
            port: 0,
            public_key: bob.peer.public_key.clone(),
            trusted: true,
            source: "test".to_string(),
            last_seen_ms: 0,
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            configure_stream(&stream).unwrap();
            accept_handshake(&mut stream, &bob, &bob_trust).unwrap().0
        });

        let mut stream = TcpStream::connect(address).unwrap();
        configure_stream(&stream).unwrap();
        connect_handshake(&mut stream, &alice, &expected_bob, &alice_trust).unwrap();
        assert_eq!(server.join().unwrap(), alice.peer);
    }

    #[test]
    fn unpinned_device_uses_its_announced_key_for_the_explicit_handshake() {
        let bob = runtime_identity("bob", "bob-device", signing_key(9));
        let peer = bob.peer.clone();
        let trusted = Arc::new(RwLock::new(HashMap::new()));
        assert_eq!(
            verification_public_key(&trusted, &peer).unwrap(),
            peer.public_key
        );
    }

    #[test]
    fn tcp_probe_authenticates_and_allows_first_trust() {
        let alice = runtime_identity("alice", "alice-device", signing_key(7));
        let bob = runtime_identity("bob", "bob-device", signing_key(9));
        let bob_trust = Arc::new(RwLock::new(HashMap::new()));
        let expected_bob = LanPeer {
            user_id: bob.peer.user_id.clone(),
            device_id: bob.peer.device_id.clone(),
            device_name: bob.device_name.clone(),
            ip: Ipv4Addr::LOCALHOST.to_string(),
            port: 0,
            public_key: bob.peer.public_key.clone(),
            trusted: false,
            source: "test".to_string(),
            last_seen_ms: 0,
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server_trust = bob_trust.clone();
        let expected_bob_peer = bob.peer.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            configure_stream(&stream).unwrap();
            accept_handshake(&mut stream, &bob, &server_trust).unwrap()
        });

        let mut stream = TcpStream::connect(address).unwrap();
        configure_stream(&stream).unwrap();
        let responder = connect_probe(&mut stream, &alice, &expected_bob).unwrap();
        let (initiator, probed) = server.join().unwrap();
        assert!(probed);
        assert_eq!(initiator, alice.peer);
        assert_eq!(responder, expected_bob_peer);
        assert!(bob_trust.read().unwrap().is_empty());
    }

    #[test]
    fn tcp_chat_delivers_without_any_rocket_chat_connection() {
        let alice = runtime_identity("alice", "alice-device", signing_key(7));
        let bob = runtime_identity("bob", "bob-device", signing_key(9));
        let alice_trust = trust(&bob);
        let bob_trust = trust(&alice);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let expected_bob = LanPeer {
            user_id: bob.peer.user_id.clone(),
            device_id: bob.peer.device_id.clone(),
            device_name: bob.device_name.clone(),
            ip: address.ip().to_string(),
            port: address.port(),
            public_key: bob.peer.public_key.clone(),
            trusted: true,
            source: "test".to_string(),
            last_seen_ms: now_ms(),
        };
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            configure_stream(&stream).unwrap();
            let peer = accept_handshake(&mut stream, &bob, &bob_trust).unwrap().0;
            let frame = read_control_frame(&mut stream).unwrap();
            assert_eq!(peer.user_id, "alice");
            assert_eq!(
                frame,
                ControlFrame::Chat {
                    message_id: "message-1".to_string(),
                    room_id: "room-1".to_string(),
                    original_ts: 123,
                    text: "offline hello".to_string(),
                }
            );
            write_control_frame(
                &mut stream,
                &ControlFrame::Ack {
                    id: "message-1".to_string(),
                },
            )
            .unwrap();
        });
        send_chat_to_peer(
            &expected_bob,
            &alice,
            &alice_trust,
            "message-1".to_string(),
            "room-1".to_string(),
            123,
            "offline hello".to_string(),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn control_frame_round_trips_and_rejects_oversize() {
        let frame = ControlFrame::Chat {
            message_id: "message-1".to_string(),
            room_id: "room-1".to_string(),
            original_ts: 123,
            text: "hello".to_string(),
        };
        let mut bytes = Vec::new();
        write_control_frame(&mut bytes, &frame).unwrap();
        assert_eq!(read_control_frame(&mut Cursor::new(bytes)).unwrap(), frame);

        let mut oversized = Cursor::new(((MAX_CONTROL_FRAME_BYTES + 1) as u32).to_be_bytes());
        assert!(read_control_frame(&mut oversized).is_err());
    }

    #[test]
    fn file_resume_requests_only_missing_verified_chunks() {
        let root = std::env::temp_dir().join(format!(
            "rocketx-lan-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let alice_key = signing_key(7);
        let alice = peer("alice", "alice-device", &alice_key);
        let transfers = Arc::new(Mutex::new(HashMap::new()));
        let mut bytes = vec![3_u8; CHUNK_BYTES as usize * 2 + 5];
        bytes[CHUNK_BYTES as usize] = 4;
        bytes[CHUNK_BYTES as usize * 2] = 5;
        let transfer = IncomingTransfer {
            version: PROTOCOL_VERSION,
            transfer_id: "a".repeat(64),
            from_user_id: alice.user_id.clone(),
            from_device_id: alice.device_id.clone(),
            message_id: "message-1".to_string(),
            room_id: "room-1".to_string(),
            original_ts: 123,
            file_name: "payload.bin".to_string(),
            size: bytes.len() as u64,
            chunk_bytes: CHUNK_BYTES,
            chunk_count: 3,
            blake3: blake3::hash(&bytes).to_hex().to_string(),
            received: Vec::new(),
        };
        assert_eq!(
            prepare_file_offer(&root, &alice, &transfers, transfer.clone()).unwrap(),
            vec![0, 1, 2]
        );
        for index in [0_u64, 2] {
            let start = index as usize * CHUNK_BYTES as usize;
            let end = (start + CHUNK_BYTES as usize).min(bytes.len());
            let chunk = &bytes[start..end];
            write_file_chunk(
                &root,
                &alice,
                &transfers,
                &transfer.transfer_id,
                index,
                &blake3::hash(chunk).to_hex().to_string(),
                chunk,
            )
            .unwrap();
        }
        assert_eq!(
            prepare_file_offer(&root, &alice, &transfers, transfer.clone()).unwrap(),
            vec![1]
        );
        let middle = &bytes[CHUNK_BYTES as usize..CHUNK_BYTES as usize * 2];
        assert!(write_file_chunk(
            &root,
            &alice,
            &transfers,
            &transfer.transfer_id,
            1,
            &"0".repeat(64),
            middle,
        )
        .is_err());
        write_file_chunk(
            &root,
            &alice,
            &transfers,
            &transfer.transfer_id,
            1,
            &blake3::hash(middle).to_hex().to_string(),
            middle,
        )
        .unwrap();
        assert!(
            prepare_file_offer(&root, &alice, &transfers, transfer.clone())
                .unwrap()
                .is_empty()
        );
        let (part, _) = transfer_paths(&root, &transfer.transfer_id);
        assert_eq!(hash_file(&part).unwrap(), transfer.blake3);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tcp_file_transfer_resumes_across_four_authenticated_streams() {
        let root = std::env::temp_dir().join(format!(
            "rocketx-lan-e2e-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let incoming = root.join("incoming");
        fs::create_dir_all(&incoming).unwrap();
        let source = root.join("payload.bin");
        let mut source_file = File::create(&source).unwrap();
        let payload_size = std::env::var("ROCKETX_LAN_E2E_BYTES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(CHUNK_BYTES as u64 * 3 + 17);
        let payload = (0..CHUNK_BYTES as usize)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut remaining = payload_size;
        while remaining > 0 {
            let length = remaining.min(payload.len() as u64) as usize;
            source_file.write_all(&payload[..length]).unwrap();
            remaining -= length as u64;
        }
        source_file.sync_all().unwrap();

        let alice = Arc::new(runtime_identity("alice", "alice-device", signing_key(7)));
        let bob = Arc::new(runtime_identity("bob", "bob-device", signing_key(9)));
        let alice_trust = trust(&bob);
        let bob_trust = trust(&alice);
        let transfers = Arc::new(Mutex::new(HashMap::new()));
        let file_hash = hash_file(&source).unwrap();
        let message_id = "message-file-1".to_string();
        let transfer_id = blake3::hash(
            format!(
                "{}\0{}\0{}\0{}",
                message_id, file_hash, bob.peer.user_id, bob.peer.device_id
            )
            .as_bytes(),
        )
        .to_hex()
        .to_string();
        let metadata = fs::metadata(&source).unwrap();
        let offer = IncomingTransfer {
            version: PROTOCOL_VERSION,
            transfer_id: transfer_id.clone(),
            from_user_id: alice.peer.user_id.clone(),
            from_device_id: alice.peer.device_id.clone(),
            message_id: message_id.clone(),
            room_id: "room-1".to_string(),
            original_ts: 123,
            file_name: "payload.bin".to_string(),
            size: metadata.len(),
            chunk_bytes: CHUNK_BYTES,
            chunk_count: metadata.len().div_ceil(CHUNK_BYTES as u64),
            blake3: file_hash.clone(),
            received: Vec::new(),
        };
        prepare_file_offer(&incoming, &alice.peer, &transfers, offer).unwrap();
        let mut first_chunk = vec![0_u8; CHUNK_BYTES as usize];
        File::open(&source)
            .unwrap()
            .read_exact(&mut first_chunk)
            .unwrap();
        write_file_chunk(
            &incoming,
            &alice.peer,
            &transfers,
            &transfer_id,
            0,
            &blake3::hash(&first_chunk).to_hex().to_string(),
            &first_chunk,
        )
        .unwrap();

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let expected_bob = LanPeer {
            user_id: bob.peer.user_id.clone(),
            device_id: bob.peer.device_id.clone(),
            device_name: bob.device_name.clone(),
            ip: address.ip().to_string(),
            port: address.port(),
            public_key: bob.peer.public_key.clone(),
            trusted: true,
            source: "test".to_string(),
            last_seen_ms: now_ms(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (completed_tx, completed_rx) = mpsc::channel();
        let server = {
            let bob = bob.clone();
            let trusted = bob_trust.clone();
            let transfers = transfers.clone();
            let incoming = incoming.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                let mut handlers = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let bob = bob.clone();
                            let trusted = trusted.clone();
                            let transfers = transfers.clone();
                            let incoming = incoming.clone();
                            let completed = completed_tx.clone();
                            let stop = stop.clone();
                            handlers.push(thread::spawn(move || {
                                let result = handle_test_file_connection(
                                    stream, bob, trusted, transfers, incoming, completed, stop,
                                );
                                if let Err(error) = &result {
                                    eprintln!("test receiver rejected connection: {error}");
                                }
                                result
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("test listener failed: {error}"),
                    }
                }
                for handler in handlers {
                    handler.join().unwrap().unwrap();
                }
            })
        };
        let receipt = send_file_to_peer(
            source.clone(),
            expected_bob,
            alice,
            alice_trust,
            message_id.clone(),
            "room-1".to_string(),
            123,
        )
        .unwrap();
        let event = completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        server.join().unwrap();
        assert_eq!(receipt.blake3, file_hash);
        assert_eq!(event.message_id, message_id);
        assert_eq!(hash_file(Path::new(&event.local_path)).unwrap(), file_hash);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn file_offer_rejects_path_traversal() {
        assert!(safe_file_name("../payload.bin").is_err());
        assert!(safe_file_name("folder/payload.bin").is_err());
        assert!(safe_file_name("payload.bin").is_ok());
    }

    #[test]
    fn identity_scope_rejects_control_characters() {
        assert!(validate_identity_scope("https://chat.example", "alice").is_ok());
        assert!(validate_identity_scope("https://chat.example\n", "alice").is_err());
        assert!(validate_identity_scope("https://chat.example", "alice\0admin").is_err());
    }
}
