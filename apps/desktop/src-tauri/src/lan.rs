use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

const KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.lan";
const PROTOCOL_CONTEXT: &[u8] = b"rocketx-lan-handshake-v1";
pub const PROTOCOL_VERSION: u16 = 1;
pub const CHUNK_BYTES: u32 = 1024 * 1024;
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;
const SERVICE_TYPE: &str = "_rcx._tcp.local.";
const UDP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 82, 67);
const UDP_PORT: u16 = 45_826;
const PEER_TTL_MS: u64 = 15_000;
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
}

struct RuntimeIdentity {
    peer: HandshakePeer,
    device_name: String,
    server_fingerprint: String,
    signing_key: SigningKey,
}

type PeerKey = (String, String);
type SharedPeers = Arc<RwLock<HashMap<PeerKey, LanPeer>>>;
type SharedTrusted = Arc<RwLock<HashMap<PeerKey, String>>>;
type SharedTransfers = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanIdentityInfo {
    pub device_id: String,
    pub device_name: String,
    pub public_key: String,
    pub protocol_version: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub user_id: String,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanPeer {
    pub user_id: String,
    pub device_id: String,
    pub device_name: String,
    pub ip: String,
    pub port: u16,
    pub public_key: String,
    pub trusted: bool,
    pub source: String,
    pub last_seen_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServiceInfo {
    pub identity: LanIdentityInfo,
    pub port: u16,
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
struct LanFileEvent {
    from_user_id: String,
    from_device_id: String,
    message_id: String,
    room_id: String,
    original_ts: i64,
    file_name: String,
    size: u64,
    blake3: String,
    local_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanFileReceipt {
    pub message_id: String,
    pub file_name: String,
    pub size: u64,
    pub blake3: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct IncomingTransfer {
    version: u16,
    transfer_id: String,
    from_user_id: String,
    from_device_id: String,
    message_id: String,
    room_id: String,
    original_ts: i64,
    file_name: String,
    size: u64,
    chunk_bytes: u32,
    chunk_count: u64,
    blake3: String,
    received: Vec<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanAnnouncement {
    version: u16,
    server_fingerprint: String,
    user_id: String,
    device_id: String,
    device_name: String,
    port: u16,
    public_key: String,
}

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    device_id: String,
    secret_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandshakePeer {
    pub user_id: String,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeTranscript {
    pub server_fingerprint: String,
    pub initiator: HandshakePeer,
    pub responder: HandshakePeer,
    pub initiator_nonce: String,
    pub responder_nonce: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControlFrame {
    Hello {
        version: u16,
        peer: HandshakePeer,
        nonce: String,
    },
    Proof {
        signature: String,
    },
    Chat {
        message_id: String,
        room_id: String,
        original_ts: i64,
        text: String,
    },
    FileOffer {
        transfer_id: String,
        message_id: String,
        room_id: String,
        original_ts: i64,
        file_name: String,
        size: u64,
        chunk_bytes: u32,
        chunk_count: u64,
        blake3: String,
    },
    MissingChunks {
        transfer_id: String,
        indexes: Vec<u64>,
    },
    FileChunk {
        transfer_id: String,
        index: u64,
        length: u32,
        blake3: String,
    },
    FileComplete {
        transfer_id: String,
    },
    Ack {
        id: String,
    },
    Error {
        code: String,
        message: String,
    },
}

fn validate_identity_scope<'a, 'b>(
    server_url: &'a str,
    user_id: &'b str,
) -> Result<(&'a str, &'b str), String> {
    if server_url.chars().any(char::is_control) || user_id.chars().any(char::is_control) {
        return Err("LAN identity scope contains control characters".to_string());
    }
    let server_url = server_url.trim();
    let user_id = user_id.trim();
    if server_url.is_empty() || server_url.len() > 2048 {
        return Err("invalid Rocket.Chat server URL".to_string());
    }
    if user_id.is_empty() || user_id.len() > 256 {
        return Err("invalid Rocket.Chat user id".to_string());
    }
    Ok((server_url, user_id))
}

pub fn server_fingerprint(server_url: &str) -> Result<String, String> {
    let (server_url, _) = validate_identity_scope(server_url, "fingerprint")?;
    Ok(blake3::hash(server_url.as_bytes()).to_hex().to_string())
}

fn identity_account(server_url: &str, user_id: &str) -> Result<String, String> {
    let (server_url, user_id) = validate_identity_scope(server_url, user_id)?;
    let mut input = Vec::with_capacity(server_url.len() + user_id.len() + 1);
    input.extend_from_slice(server_url.as_bytes());
    input.push(0);
    input.extend_from_slice(user_id.as_bytes());
    Ok(format!("identity-{}", blake3::hash(&input).to_hex()))
}

fn keychain_entry(server_url: &str, user_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &identity_account(server_url, user_id)?)
        .map_err(|error| format!("LAN identity keychain is unavailable: {error}"))
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|error| format!("secure random source failed: {error}"))?;
    Ok(bytes)
}

fn decode_secret(record: &StoredIdentity) -> Result<SigningKey, String> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(&record.secret_key)
            .map_err(|_| "stored LAN identity is invalid".to_string())?,
    );
    let secret: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "stored LAN identity has invalid length".to_string())?;
    Ok(SigningKey::from_bytes(&secret))
}

fn load_or_create_identity(server_url: &str, user_id: &str) -> Result<StoredIdentity, String> {
    let entry = keychain_entry(server_url, user_id)?;
    match entry.get_password() {
        Ok(serialized) => serde_json::from_str(&serialized)
            .map_err(|_| "stored LAN identity record is invalid".to_string()),
        Err(keyring::Error::NoEntry) => {
            let secret = Zeroizing::new(random_bytes::<32>()?);
            let record = StoredIdentity {
                device_id: URL_SAFE_NO_PAD.encode(random_bytes::<16>()?),
                secret_key: URL_SAFE_NO_PAD.encode(secret.as_slice()),
            };
            entry
                .set_password(
                    &serde_json::to_string(&record)
                        .map_err(|error| format!("failed to encode LAN identity: {error}"))?,
                )
                .map_err(|error| format!("failed to save LAN identity: {error}"))?;
            Ok(record)
        }
        Err(error) => Err(format!("failed to read LAN identity: {error}")),
    }
}

#[tauri::command]
pub fn lan_identity_get(
    lock: tauri::State<'_, LanKeychainLock>,
    server_url: String,
    user_id: String,
    device_name: String,
) -> Result<LanIdentityInfo, String> {
    if device_name.chars().any(char::is_control) {
        return Err("invalid device name".to_string());
    }
    let device_name = device_name.trim();
    if device_name.is_empty() || device_name.len() > 128 {
        return Err("invalid device name".to_string());
    }
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "LAN identity keychain lock is unavailable".to_string())?;
    let record = load_or_create_identity(&server_url, &user_id)?;
    let signing_key = decode_secret(&record)?;
    Ok(LanIdentityInfo {
        device_id: record.device_id,
        device_name: device_name.to_string(),
        public_key: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
        protocol_version: PROTOCOL_VERSION,
    })
}

fn append_transcript_field(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value.as_bytes());
}

fn transcript_bytes(transcript: &HandshakeTranscript) -> Vec<u8> {
    let mut output = Vec::with_capacity(512);
    output.extend_from_slice(PROTOCOL_CONTEXT);
    for value in [
        &transcript.server_fingerprint,
        &transcript.initiator.user_id,
        &transcript.initiator.device_id,
        &transcript.initiator.public_key,
        &transcript.responder.user_id,
        &transcript.responder.device_id,
        &transcript.responder.public_key,
        &transcript.initiator_nonce,
        &transcript.responder_nonce,
    ] {
        append_transcript_field(&mut output, value);
    }
    output
}

pub fn sign_transcript(signing_key: &SigningKey, transcript: &HandshakeTranscript) -> String {
    URL_SAFE_NO_PAD.encode(signing_key.sign(&transcript_bytes(transcript)).to_bytes())
}

pub fn verify_transcript(
    pinned_public_key: &str,
    transcript: &HandshakeTranscript,
    signature: &str,
) -> Result<(), String> {
    let public_key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(pinned_public_key)
        .map_err(|_| "peer public key is not valid base64".to_string())?
        .try_into()
        .map_err(|_| "peer public key has invalid length".to_string())?;
    let signature: [u8; 64] = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "peer signature is not valid base64".to_string())?
        .try_into()
        .map_err(|_| "peer signature has invalid length".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "peer public key is invalid".to_string())?;
    verifying_key
        .verify_strict(
            &transcript_bytes(transcript),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| "peer challenge response was rejected".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn peer_key(user_id: &str, device_id: &str) -> PeerKey {
    (user_id.to_string(), device_id.to_string())
}

fn trusted_public_key(trusted: &SharedTrusted, peer: &HandshakePeer) -> Result<String, String> {
    let trusted = trusted
        .read()
        .map_err(|_| "LAN trust store is unavailable".to_string())?;
    let pinned = trusted
        .get(&peer_key(&peer.user_id, &peer.device_id))
        .ok_or_else(|| "LAN peer has no Rocket.Chat-authenticated device key".to_string())?;
    if pinned != &peer.public_key {
        return Err("LAN peer broadcast key does not match the pinned device key".to_string());
    }
    Ok(pinned.clone())
}

fn random_nonce() -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

fn announcement_from_identity(identity: &RuntimeIdentity, port: u16) -> LanAnnouncement {
    LanAnnouncement {
        version: PROTOCOL_VERSION,
        server_fingerprint: identity.server_fingerprint.clone(),
        user_id: identity.peer.user_id.clone(),
        device_id: identity.peer.device_id.clone(),
        device_name: identity.device_name.clone(),
        port,
        public_key: identity.peer.public_key.clone(),
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
        peers.insert(
            key,
            LanPeer {
                user_id: announcement.user_id,
                device_id: announcement.device_id,
                device_name: announcement.device_name,
                ip: ip.to_string(),
                port: announcement.port,
                public_key: announcement.public_key,
                trusted: is_trusted,
                source: source.to_string(),
                last_seen_ms: now_ms(),
            },
        );
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
) -> Result<HandshakePeer, String> {
    let (initiator, initiator_nonce) = read_hello(stream)?;
    let pinned = trusted_public_key(trusted, &initiator)?;
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
    verify_transcript(&pinned, &transcript, &read_proof(stream)?)?;
    write_control_frame(
        stream,
        &ControlFrame::Proof {
            signature: sign_transcript(&identity.signing_key, &transcript),
        },
    )?;
    Ok(initiator)
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
    let pinned = trusted_public_key(trusted, &responder)?;
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

pub fn write_control_frame(writer: &mut impl Write, frame: &ControlFrame) -> Result<(), String> {
    let payload = serde_json::to_vec(frame)
        .map_err(|error| format!("failed to encode LAN control frame: {error}"))?;
    if payload.len() > MAX_CONTROL_FRAME_BYTES {
        return Err("LAN control frame exceeds size limit".to_string());
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .map_err(|error| format!("failed to write LAN control frame: {error}"))
}

pub fn read_control_frame(reader: &mut impl Read) -> Result<ControlFrame, String> {
    let mut length = [0_u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| format!("failed to read LAN control frame length: {error}"))?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_CONTROL_FRAME_BYTES {
        return Err("LAN control frame has invalid length".to_string());
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("failed to read LAN control frame: {error}"))?;
    serde_json::from_slice(&payload)
        .map_err(|error| format!("LAN control frame is invalid: {error}"))
}

fn trusted_map(devices: Vec<TrustedDevice>) -> Result<HashMap<PeerKey, String>, String> {
    let mut trusted = HashMap::new();
    for device in devices {
        if device.user_id.is_empty()
            || device.user_id.len() > 256
            || device.device_id.is_empty()
            || device.device_id.len() > 128
            || device.user_id.chars().any(char::is_control)
            || device.device_id.chars().any(char::is_control)
        {
            return Err("trusted LAN device identity is invalid".to_string());
        }
        let public_key = URL_SAFE_NO_PAD
            .decode(&device.public_key)
            .map_err(|_| "trusted LAN device public key is invalid".to_string())?;
        if public_key.len() != 32 {
            return Err("trusted LAN device public key has invalid length".to_string());
        }
        trusted.insert(
            peer_key(&device.user_id, &device.device_id),
            device.public_key,
        );
    }
    Ok(trusted)
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
        let destination = SocketAddrV4::new(UDP_GROUP, UDP_PORT);
        let mut buffer = [0_u8; 8192];
        let mut next_announcement = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            if Instant::now() >= next_announcement {
                let _ = socket.send_to(&payload, destination);
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

fn valid_transfer_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_file_name(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
        return Err("LAN file name is invalid".to_string());
    }
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "LAN file name is invalid".to_string())?;
    if name != value || matches!(name, "." | "..") {
        return Err("LAN file name is invalid".to_string());
    }
    Ok(name.to_string())
}

fn valid_blake3(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn transfer_paths(root: &Path, transfer_id: &str) -> (PathBuf, PathBuf) {
    (
        root.join(format!("{transfer_id}.part")),
        root.join(format!("{transfer_id}.json")),
    )
}

fn transfer_lock(transfers: &SharedTransfers, transfer_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut transfers = transfers
        .lock()
        .map_err(|_| "LAN transfer lock is unavailable".to_string())?;
    Ok(transfers
        .entry(transfer_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn save_transfer(path: &Path, transfer: &IncomingTransfer) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec(transfer)
        .map_err(|error| format!("failed to encode LAN transfer state: {error}"))?;
    fs::write(&temporary, payload)
        .map_err(|error| format!("failed to save LAN transfer state: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to replace LAN transfer state: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to commit LAN transfer state: {error}"))
}

fn load_transfer(path: &Path) -> Result<IncomingTransfer, String> {
    let payload =
        fs::read(path).map_err(|error| format!("failed to read LAN transfer state: {error}"))?;
    serde_json::from_slice(&payload)
        .map_err(|error| format!("LAN transfer state is invalid: {error}"))
}

fn incoming_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve LAN receive directory: {error}"))?
        .join("lan-incoming");
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to prepare LAN receive directory: {error}"))?;
    Ok(root)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to open LAN file for hashing: {error}"))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; CHUNK_BYTES as usize];
    loop {
        let length = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash LAN file: {error}"))?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn prepare_file_offer(
    root: &Path,
    peer: &HandshakePeer,
    transfers: &SharedTransfers,
    offer: IncomingTransfer,
) -> Result<Vec<u64>, String> {
    if !valid_transfer_id(&offer.transfer_id)
        || offer.version != PROTOCOL_VERSION
        || offer.message_id.is_empty()
        || offer.message_id.len() > 256
        || offer.room_id.is_empty()
        || offer.room_id.len() > 256
        || offer.original_ts <= 0
        || offer.chunk_bytes != CHUNK_BYTES
        || offer.chunk_count != offer.size.div_ceil(CHUNK_BYTES as u64)
        || offer.chunk_count > 8192
        || offer.chunk_count > usize::MAX as u64
        || !valid_blake3(&offer.blake3)
    {
        return Err("LAN file offer failed validation".to_string());
    }
    safe_file_name(&offer.file_name)?;
    let lock = transfer_lock(transfers, &offer.transfer_id)?;
    let _guard = lock
        .lock()
        .map_err(|_| "LAN transfer lock is unavailable".to_string())?;
    let (part_path, manifest_path) = transfer_paths(root, &offer.transfer_id);
    let transfer = if manifest_path.exists() {
        let existing = load_transfer(&manifest_path)?;
        if existing.transfer_id != offer.transfer_id
            || existing.from_user_id != peer.user_id
            || existing.from_device_id != peer.device_id
            || existing.message_id != offer.message_id
            || existing.room_id != offer.room_id
            || existing.original_ts != offer.original_ts
            || existing.file_name != offer.file_name
            || existing.size != offer.size
            || existing.chunk_bytes != offer.chunk_bytes
            || existing.chunk_count != offer.chunk_count
            || existing.blake3 != offer.blake3
        {
            return Err("LAN transfer id conflicts with existing state".to_string());
        }
        existing
    } else {
        let mut created = offer;
        created.received = vec![false; created.chunk_count as usize];
        let part = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&part_path)
            .map_err(|error| format!("failed to create LAN partial file: {error}"))?;
        part.set_len(created.size)
            .map_err(|error| format!("failed to size LAN partial file: {error}"))?;
        save_transfer(&manifest_path, &created)?;
        created
    };
    Ok(transfer
        .received
        .iter()
        .enumerate()
        .filter_map(|(index, received)| (!received).then_some(index as u64))
        .collect())
}

fn write_file_chunk(
    root: &Path,
    peer: &HandshakePeer,
    transfers: &SharedTransfers,
    transfer_id: &str,
    index: u64,
    claimed_hash: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if !valid_transfer_id(transfer_id)
        || bytes.is_empty()
        || bytes.len() > CHUNK_BYTES as usize
        || !valid_blake3(claimed_hash)
        || blake3::hash(bytes).to_hex().as_str() != claimed_hash
    {
        return Err("LAN file chunk failed validation".to_string());
    }
    let lock = transfer_lock(transfers, transfer_id)?;
    let (part_path, manifest_path) = transfer_paths(root, transfer_id);
    let (offset, expected) = {
        let _guard = lock
            .lock()
            .map_err(|_| "LAN transfer lock is unavailable".to_string())?;
        let transfer = load_transfer(&manifest_path)?;
        if transfer.from_user_id != peer.user_id
            || transfer.from_device_id != peer.device_id
            || index >= transfer.chunk_count
        {
            return Err("LAN file chunk does not match its offer".to_string());
        }
        let expected = if index + 1 == transfer.chunk_count {
            (transfer.size - index * transfer.chunk_bytes as u64) as usize
        } else {
            transfer.chunk_bytes as usize
        };
        (index * transfer.chunk_bytes as u64, expected)
    };
    if bytes.len() != expected {
        return Err("LAN file chunk has an invalid length".to_string());
    }
    let mut part = OpenOptions::new()
        .write(true)
        .open(&part_path)
        .map_err(|error| format!("failed to open LAN partial file: {error}"))?;
    part.seek(SeekFrom::Start(offset))
        .and_then(|_| part.write_all(bytes))
        .map_err(|error| format!("failed to write LAN file chunk: {error}"))?;
    let _guard = lock
        .lock()
        .map_err(|_| "LAN transfer lock is unavailable".to_string())?;
    let mut transfer = load_transfer(&manifest_path)?;
    transfer.received[index as usize] = true;
    save_transfer(&manifest_path, &transfer)
}

fn finish_file_transfer(
    root: &Path,
    peer: &HandshakePeer,
    transfers: &SharedTransfers,
    transfer_id: &str,
) -> Result<LanFileEvent, String> {
    let lock = transfer_lock(transfers, transfer_id)?;
    let _guard = lock
        .lock()
        .map_err(|_| "LAN transfer lock is unavailable".to_string())?;
    let (part_path, manifest_path) = transfer_paths(root, transfer_id);
    let transfer = load_transfer(&manifest_path)?;
    if transfer.from_user_id != peer.user_id
        || transfer.from_device_id != peer.device_id
        || transfer.received.iter().any(|received| !received)
    {
        return Err("LAN file transfer is incomplete".to_string());
    }
    let file_name = safe_file_name(&transfer.file_name)?;
    let final_path = root.join(format!("{}-{file_name}", &transfer.transfer_id[..12]));
    if part_path.exists() {
        if hash_file(&part_path)? != transfer.blake3 {
            return Err("LAN file failed final BLAKE3 verification".to_string());
        }
        if final_path.exists() {
            if hash_file(&final_path)? != transfer.blake3 {
                return Err("LAN receive destination already contains different data".to_string());
            }
            fs::remove_file(&part_path)
                .map_err(|error| format!("failed to remove duplicate LAN partial file: {error}"))?;
        } else {
            fs::rename(&part_path, &final_path)
                .map_err(|error| format!("failed to finalize LAN file: {error}"))?;
        }
    } else if !final_path.exists() || hash_file(&final_path)? != transfer.blake3 {
        return Err("LAN completed file is missing or corrupted".to_string());
    }
    Ok(LanFileEvent {
        from_user_id: peer.user_id.clone(),
        from_device_id: peer.device_id.clone(),
        message_id: transfer.message_id,
        room_id: transfer.room_id,
        original_ts: transfer.original_ts,
        file_name: transfer.file_name,
        size: transfer.size,
        blake3: transfer.blake3,
        local_path: final_path.to_string_lossy().to_string(),
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
    let peer = accept_handshake(&mut stream, &identity, &trusted)?;
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
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let identity = identity.clone();
                    let trusted = trusted.clone();
                    let transfers = transfers.clone();
                    thread::spawn(move || {
                        if let Err(error) =
                            handle_incoming(app, stream, identity, trusted, transfers)
                        {
                            log::warn!("LAN connection rejected: {error}");
                        }
                    });
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

fn build_runtime_identity(
    server_url: &str,
    user_id: &str,
    device_name: &str,
) -> Result<(Arc<RuntimeIdentity>, LanIdentityInfo), String> {
    if device_name.chars().any(char::is_control) {
        return Err("invalid device name".to_string());
    }
    let device_name = device_name.trim();
    if device_name.is_empty() || device_name.len() > 128 {
        return Err("invalid device name".to_string());
    }
    let record = load_or_create_identity(server_url, user_id)?;
    let signing_key = decode_secret(&record)?;
    let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let info = LanIdentityInfo {
        device_id: record.device_id.clone(),
        device_name: device_name.to_string(),
        public_key: public_key.clone(),
        protocol_version: PROTOCOL_VERSION,
    };
    Ok((
        Arc::new(RuntimeIdentity {
            peer: HandshakePeer {
                user_id: user_id.trim().to_string(),
                device_id: record.device_id,
                public_key,
            },
            device_name: device_name.to_string(),
            server_fingerprint: server_fingerprint(server_url)?,
            signing_key,
        }),
        info,
    ))
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
    current.stop.store(true, Ordering::Relaxed);
    let _ = current.mdns.unregister(&current.service_fullname);
    let _ = current.mdns.shutdown();
    for thread in current.threads {
        let _ = thread.join();
    }
    Ok(())
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
        let peer = accept_handshake(&mut stream, &identity, &trusted)?;
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
            accept_handshake(&mut stream, &bob, &bob_trust).unwrap()
        });

        let mut stream = TcpStream::connect(address).unwrap();
        configure_stream(&stream).unwrap();
        connect_handshake(&mut stream, &alice, &expected_bob, &alice_trust).unwrap();
        assert_eq!(server.join().unwrap(), alice.peer);
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
            let peer = accept_handshake(&mut stream, &bob, &bob_trust).unwrap();
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
