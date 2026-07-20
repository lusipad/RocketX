use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use encoding_rs::{GBK, SHIFT_JIS};
use serde::Serialize;
use tauri::{Emitter, Manager};

pub const IPMSG_PORT: u16 = 2425;
const INTRANET_PORT: u16 = 9011;
const MAX_DATAGRAM_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 48 * 1024;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const PEER_TTL: Duration = Duration::from_secs(180);
const OFFER_TTL: Duration = Duration::from_secs(30 * 60);
const DEDUP_TTL: Duration = Duration::from_secs(10 * 60);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const ACK_TIMEOUT: Duration = Duration::from_millis(900);
const ACK_ATTEMPTS: usize = 5;

const IPMSG_BR_ENTRY: u32 = 0x0000_0001;
const IPMSG_BR_EXIT: u32 = 0x0000_0002;
const IPMSG_ANSENTRY: u32 = 0x0000_0003;
const IPMSG_BR_ABSENCE: u32 = 0x0000_0004;
const IPMSG_SENDMSG: u32 = 0x0000_0020;
const IPMSG_RECVMSG: u32 = 0x0000_0021;
const IPMSG_GETFILEDATA: u32 = 0x0000_0060;
const IPMSG_RELEASEFILES: u32 = 0x0000_0061;

const IPMSG_SENDCHECKOPT: u32 = 0x0000_0100;
const IPMSG_FILEATTACHOPT: u32 = 0x0020_0000;
const IPMSG_UTF8OPT: u32 = 0x0080_0000;
const IPMSG_CAPUTF8OPT: u32 = 0x0100_0000;
const COMMAND_MASK: u32 = 0xff;
const FEIQ_VERSION: &str = "1_lbt6_0#128#ROCKETX#0#0#0#4001#9";

static PACKET_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct IpmsgRuntimeState(Mutex<Option<IpmsgRuntime>>);

struct IpmsgRuntime {
    stop: Arc<AtomicBool>,
    sockets: Vec<(u16, Arc<UdpSocket>)>,
    identity: Arc<IpmsgIdentity>,
    peers: SharedPeers,
    acks: SharedAcks,
    outgoing: SharedOutgoing,
    incoming: SharedIncoming,
    threads: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
struct IpmsgIdentity {
    user: String,
    host: String,
    nickname: String,
    group: String,
}

type SharedPeers = Arc<RwLock<HashMap<String, PeerRecord>>>;
type SharedAcks = Arc<(Mutex<HashSet<String>>, Condvar)>;
type SharedOutgoing = Arc<Mutex<HashMap<String, OutgoingOffer>>>;
type SharedIncoming = Arc<Mutex<HashMap<String, IncomingOffer>>>;

#[derive(Clone)]
struct PeerRecord {
    peer: IpmsgPeer,
    address: SocketAddr,
    local_port: u16,
    command: u32,
    dialect: Dialect,
    last_seen: Instant,
}

#[derive(Clone)]
struct OutgoingOffer {
    peer_ip: IpAddr,
    packet_no: String,
    file_id: u64,
    path: PathBuf,
    size: u64,
    expires_at: Instant,
}

#[derive(Clone)]
struct IncomingOffer {
    offer: IpmsgFileOffer,
    address: SocketAddr,
    packet_no: String,
    file_id: u64,
    alternate_file_id: Option<u64>,
    dialect: Dialect,
    utf8: bool,
    expires_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dialect {
    Standard,
    Feiq,
    Intranet,
}

impl Dialect {
    fn label(self) -> &'static str {
        match self {
            Self::Standard => "ipmsg",
            Self::Feiq => "feiq",
            Self::Intranet => "intranet",
        }
    }
}

#[derive(Clone, Debug)]
struct Packet {
    packet_no: String,
    user: String,
    host: String,
    command: u32,
    extra: String,
    attachment: Vec<u8>,
    dialect: Dialect,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpmsgPeer {
    id: String,
    user: String,
    host: String,
    nickname: String,
    group: String,
    ip: String,
    port: u16,
    dialect: String,
    supports_utf8: bool,
    last_seen_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpmsgStatus {
    enabled: bool,
    port: u16,
    peer_count: usize,
    intranet_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IpmsgPeerEvent {
    kind: String,
    peer: IpmsgPeer,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IpmsgMessageEvent {
    id: String,
    packet_no: String,
    peer_id: String,
    user: String,
    host: String,
    nickname: String,
    text: String,
    received_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpmsgSendReceipt {
    packet_no: String,
    acknowledged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpmsgFileOffer {
    id: String,
    peer_id: String,
    file_name: String,
    size: u64,
    modified_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpmsgFileReceipt {
    offer_id: String,
    file_name: String,
    size: u64,
    local_path: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_packet_no() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let counter = PACKET_COUNTER.fetch_add(1, Ordering::Relaxed) % 1_000_000;
    format!("{seconds}{counter:06}")
}

fn sanitize_identity(value: &str, fallback: &str) -> String {
    let value = value
        .trim()
        .chars()
        .filter(|character| !character.is_control() && *character != ':')
        .take(128)
        .collect::<String>();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map(|value| sanitize_identity(&value, "rocketx"))
        .unwrap_or_else(|_| "rocketx".to_string())
}

fn peer_id(address: SocketAddr, user: &str, host: &str) -> String {
    blake3::hash(format!("{}\0{}\0{}", address, user, host).as_bytes()).to_hex()[..24].to_string()
}

fn decode(bytes: &[u8], dialect: Dialect, utf8: bool) -> Result<String, String> {
    if utf8 {
        return String::from_utf8(bytes.to_vec())
            .map_err(|_| "IPMSG packet contains invalid UTF-8".to_string());
    }
    let encoding = if matches!(dialect, Dialect::Feiq | Dialect::Intranet) {
        GBK
    } else {
        SHIFT_JIS
    };
    let (value, _, malformed) = encoding.decode(bytes);
    if malformed {
        return Err("IPMSG packet contains invalid legacy text".to_string());
    }
    Ok(value.into_owned())
}

fn encode(value: &str, dialect: Dialect, utf8: bool) -> Result<Vec<u8>, String> {
    if utf8 {
        return Ok(value.as_bytes().to_vec());
    }
    let encoding = if matches!(dialect, Dialect::Feiq | Dialect::Intranet) {
        GBK
    } else {
        SHIFT_JIS
    };
    let (value, _, unmappable) = encoding.encode(value);
    if unmappable {
        return Err("IPMSG peer cannot represent this text encoding".to_string());
    }
    Ok(value.into_owned())
}

fn colon_positions(bytes: &[u8]) -> Option<[usize; 5]> {
    let mut positions = [0_usize; 5];
    let mut count = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b':' {
            positions[count] = index;
            count += 1;
            if count == positions.len() {
                return Some(positions);
            }
        }
    }
    None
}

fn parse_packet_with_dialect(bytes: &[u8], fallback_dialect: Dialect) -> Result<Packet, String> {
    if bytes.is_empty() || bytes.len() > MAX_DATAGRAM_BYTES {
        return Err("IPMSG packet has an invalid length".to_string());
    }
    let positions =
        colon_positions(bytes).ok_or_else(|| "IPMSG packet is truncated".to_string())?;
    let command_bytes = &bytes[positions[3] + 1..positions[4]];
    let command_text =
        std::str::from_utf8(command_bytes).map_err(|_| "IPMSG command is not ASCII".to_string())?;
    let command = command_text
        .parse::<u32>()
        .map_err(|_| "IPMSG command is invalid".to_string())?;
    let version_bytes = &bytes[..positions[0]];
    let version = std::str::from_utf8(version_bytes)
        .map_err(|_| "IPMSG version is not ASCII".to_string())?
        .to_string();
    let dialect = if version.starts_with("1_lbt") {
        Dialect::Feiq
    } else {
        fallback_dialect
    };
    let utf8 = command & IPMSG_UTF8OPT != 0;
    let packet_no = std::str::from_utf8(&bytes[positions[0] + 1..positions[1]])
        .map_err(|_| "IPMSG packet number is not ASCII".to_string())?
        .to_string();
    if packet_no.is_empty()
        || packet_no.len() > 64
        || !packet_no.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("IPMSG packet number is invalid".to_string());
    }
    let user = decode(&bytes[positions[1] + 1..positions[2]], dialect, utf8)?;
    let host = decode(&bytes[positions[2] + 1..positions[3]], dialect, utf8)?;
    if user.is_empty() || host.is_empty() || user.len() > 256 || host.len() > 256 {
        return Err("IPMSG sender identity is invalid".to_string());
    }
    let payload = &bytes[positions[4] + 1..];
    let (extra_bytes, attachment) = match payload.iter().position(|byte| *byte == 0) {
        Some(index) => (&payload[..index], payload[index + 1..].to_vec()),
        None => (payload, Vec::new()),
    };
    let extra = decode(extra_bytes, dialect, utf8)?;
    Ok(Packet {
        packet_no,
        user,
        host,
        command,
        extra,
        attachment,
        dialect,
    })
}

fn parse_packet(bytes: &[u8]) -> Result<Packet, String> {
    parse_packet_with_dialect(bytes, Dialect::Standard)
}

fn dialect_for_port(port: u16) -> Dialect {
    if port == INTRANET_PORT {
        Dialect::Intranet
    } else {
        Dialect::Standard
    }
}

fn parse_packet_for_port(bytes: &[u8], local_port: u16) -> Result<Packet, String> {
    if local_port == INTRANET_PORT {
        parse_packet_with_dialect(bytes, dialect_for_port(local_port))
    } else {
        parse_packet(bytes)
    }
}

fn packet_version(dialect: Dialect) -> &'static str {
    if dialect == Dialect::Feiq {
        FEIQ_VERSION
    } else {
        "1"
    }
}

fn build_packet(
    identity: &IpmsgIdentity,
    dialect: Dialect,
    packet_no: &str,
    command: u32,
    extra: &str,
    attachment: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let utf8 = command & IPMSG_UTF8OPT != 0;
    let mut packet = Vec::new();
    packet.extend_from_slice(packet_version(dialect).as_bytes());
    packet.push(b':');
    packet.extend_from_slice(packet_no.as_bytes());
    packet.push(b':');
    packet.extend_from_slice(&encode(&identity.user, dialect, utf8)?);
    packet.push(b':');
    packet.extend_from_slice(&encode(&identity.host, dialect, utf8)?);
    packet.push(b':');
    packet.extend_from_slice(command.to_string().as_bytes());
    packet.push(b':');
    packet.extend_from_slice(&encode(extra, dialect, utf8)?);
    if let Some(attachment) = attachment {
        packet.push(0);
        packet.extend_from_slice(attachment);
    } else {
        // Official clients include the body terminator in both UDP and TCP packets.
        packet.push(0);
    }
    if packet.len() > MAX_DATAGRAM_BYTES {
        return Err("IPMSG packet exceeds the UDP limit".to_string());
    }
    Ok(packet)
}

fn safe_file_name(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || Path::new(value).file_name().and_then(|name| name.to_str()) != Some(value)
    {
        return Err("IPMSG file name is unsafe".to_string());
    }
    Ok(value)
}

fn split_file_fields(value: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == ':' {
            if chars.peek() == Some(&':') {
                chars.next();
                current.push(':');
            } else {
                fields.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    fields.push(current);
    fields
}

fn parse_file_id(value: &str) -> Option<(u64, Option<u64>)> {
    let hexadecimal = u64::from_str_radix(value, 16).ok()?;
    // Official IP Messenger 5.x ipcmd emits its 32-bit file id as decimal even
    // though the legacy attachment grammar says hexadecimal. GETFILEDATA still
    // expects that numeric value formatted as hexadecimal. Numeric-only ids are
    // ambiguous, so keep the legacy interpretation as a zero-byte fallback.
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        let decimal = value.parse().ok()?;
        Some((
            decimal,
            if decimal == hexadecimal {
                None
            } else {
                Some(hexadecimal)
            },
        ))
    } else {
        Some((hexadecimal, None))
    }
}

fn parse_file_offers(packet: &Packet, record: &PeerRecord) -> Vec<IncomingOffer> {
    if packet.command & IPMSG_FILEATTACHOPT == 0 || packet.attachment.is_empty() {
        return Vec::new();
    }
    let utf8 = packet.command & IPMSG_UTF8OPT != 0;
    let Ok(value) = decode(&packet.attachment, packet.dialect, utf8) else {
        return Vec::new();
    };
    value
        .split('\u{7}')
        .filter_map(|item| {
            let fields = split_file_fields(item.trim_matches(':'));
            if fields.len() < 5 {
                return None;
            }
            let (file_id, alternate_file_id) = parse_file_id(&fields[0])?;
            let file_name = safe_file_name(&fields[1]).ok()?.to_string();
            let size = u64::from_str_radix(&fields[2], 16).ok()?;
            let modified_at = u64::from_str_radix(&fields[3], 16).ok()?;
            let attributes = u32::from_str_radix(&fields[4], 16).ok()?;
            if attributes & 0xff != 1 || size > MAX_FILE_BYTES {
                return None;
            }
            let id = blake3::hash(
                format!(
                    "{}\0{}\0{}\0{}",
                    record.peer.id, packet.packet_no, file_id, file_name
                )
                .as_bytes(),
            )
            .to_hex()[..32]
                .to_string();
            Some(IncomingOffer {
                offer: IpmsgFileOffer {
                    id,
                    peer_id: record.peer.id.clone(),
                    file_name,
                    size,
                    modified_at,
                },
                address: record.address,
                packet_no: packet.packet_no.clone(),
                file_id,
                alternate_file_id,
                dialect: packet.dialect,
                utf8,
                expires_at: Instant::now() + OFFER_TTL,
            })
        })
        .collect()
}

fn peer_from_packet(packet: &Packet, address: SocketAddr, local_port: u16) -> PeerRecord {
    let nickname = if packet.extra.is_empty() {
        &packet.user
    } else {
        &packet.extra
    };
    let group = if matches!(
        packet.command & COMMAND_MASK,
        IPMSG_BR_ENTRY | IPMSG_ANSENTRY | IPMSG_BR_ABSENCE
    ) {
        decode(
            &packet.attachment,
            packet.dialect,
            packet.command & IPMSG_UTF8OPT != 0,
        )
        .unwrap_or_default()
    } else {
        String::new()
    };
    let id = peer_id(address, &packet.user, &packet.host);
    PeerRecord {
        peer: IpmsgPeer {
            id,
            user: packet.user.clone(),
            host: packet.host.clone(),
            nickname: sanitize_identity(nickname, &packet.user),
            group: sanitize_identity(&group, ""),
            ip: address.ip().to_string(),
            port: address.port(),
            dialect: packet.dialect.label().to_string(),
            supports_utf8: packet.command & IPMSG_CAPUTF8OPT != 0,
            last_seen_ms: now_ms(),
        },
        address,
        local_port,
        command: packet.command,
        dialect: packet.dialect,
        last_seen: Instant::now(),
    }
}

fn send_packet(socket: &UdpSocket, address: SocketAddr, packet: &[u8]) -> Result<(), String> {
    socket
        .send_to(packet, address)
        .map_err(|error| format!("failed to send IPMSG packet: {error}"))?;
    Ok(())
}

fn entry_extra(identity: &IpmsgIdentity) -> String {
    if identity.group.is_empty() {
        identity.nickname.clone()
    } else {
        format!("{}\0{}", identity.nickname, identity.group)
    }
}

fn announce(
    socket: &UdpSocket,
    identity: &IpmsgIdentity,
    command: u32,
    address: SocketAddr,
) -> Result<(), String> {
    let packet_no = next_packet_no();
    let packet = build_packet(
        identity,
        dialect_for_port(address.port()),
        &packet_no,
        command | IPMSG_CAPUTF8OPT | IPMSG_FILEATTACHOPT,
        &entry_extra(identity),
        None,
    )?;
    send_packet(socket, address, &packet)
}

fn ack_key(address: SocketAddr, packet_no: &str) -> String {
    format!("{}:{packet_no}", address.ip())
}

fn wait_for_ack(
    socket: &UdpSocket,
    acks: &SharedAcks,
    address: SocketAddr,
    packet_no: &str,
    packet: &[u8],
) -> Result<bool, String> {
    let key = ack_key(address, packet_no);
    for _ in 0..ACK_ATTEMPTS {
        send_packet(socket, address, packet)?;
        let (lock, condition) = &**acks;
        let guard = lock
            .lock()
            .map_err(|_| "IPMSG acknowledgement store is unavailable".to_string())?;
        let (mut guard, _) = condition
            .wait_timeout_while(guard, ACK_TIMEOUT, |values| !values.contains(&key))
            .map_err(|_| "IPMSG acknowledgement wait failed".to_string())?;
        if guard.remove(&key) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn prune<T>(values: &mut HashMap<String, (Instant, T)>, ttl: Duration) {
    let now = Instant::now();
    values.retain(|_, (seen_at, _)| now.duration_since(*seen_at) <= ttl);
}

fn udp_loop(
    app: tauri::AppHandle,
    socket: UdpSocket,
    local_port: u16,
    identity: Arc<IpmsgIdentity>,
    peers: SharedPeers,
    acks: SharedAcks,
    outgoing: SharedOutgoing,
    incoming: SharedIncoming,
    stop: Arc<AtomicBool>,
) {
    let mut buffer = vec![0_u8; MAX_DATAGRAM_BYTES];
    let mut received: HashMap<String, (Instant, ())> = HashMap::new();
    while !stop.load(Ordering::Relaxed) {
        let (length, address) = match socket.recv_from(&mut buffer) {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => break,
        };
        let Ok(packet) = parse_packet_for_port(&buffer[..length], local_port) else {
            continue;
        };
        let mode = packet.command & COMMAND_MASK;
        if mode == IPMSG_RECVMSG {
            let key = ack_key(address, packet.extra.trim());
            let (lock, condition) = &*acks;
            if let Ok(mut values) = lock.lock() {
                values.insert(key);
                condition.notify_all();
            }
            continue;
        }
        if mode == IPMSG_RELEASEFILES {
            if let Ok(mut offers) = outgoing.lock() {
                offers.retain(|_, offer| {
                    offer.peer_ip != address.ip() || offer.packet_no != packet.extra.trim()
                });
            }
            continue;
        }
        if matches!(
            mode,
            IPMSG_BR_ENTRY | IPMSG_ANSENTRY | IPMSG_BR_ABSENCE | IPMSG_SENDMSG
        ) {
            let record = peer_from_packet(&packet, address, local_port);
            let peer = record.peer.clone();
            if let Ok(mut values) = peers.write() {
                values.insert(peer.id.clone(), record.clone());
            }
            let _ = app.emit(
                "rocketx://ipmsg-peer",
                IpmsgPeerEvent {
                    kind: "upsert".to_string(),
                    peer,
                },
            );
            if mode == IPMSG_BR_ENTRY {
                let utf8 = record.command & IPMSG_CAPUTF8OPT != 0;
                let command = IPMSG_ANSENTRY
                    | IPMSG_CAPUTF8OPT
                    | IPMSG_FILEATTACHOPT
                    | if utf8 { IPMSG_UTF8OPT } else { 0 };
                if let Ok(response) = build_packet(
                    &identity,
                    record.dialect,
                    &next_packet_no(),
                    command,
                    &entry_extra(&identity),
                    None,
                ) {
                    let _ = send_packet(&socket, address, &response);
                }
            }
            if mode == IPMSG_SENDMSG {
                if packet.command & IPMSG_SENDCHECKOPT != 0 {
                    let command = IPMSG_RECVMSG
                        | if packet.command & IPMSG_UTF8OPT != 0 {
                            IPMSG_UTF8OPT
                        } else {
                            0
                        };
                    if let Ok(response) = build_packet(
                        &identity,
                        packet.dialect,
                        &next_packet_no(),
                        command,
                        &packet.packet_no,
                        None,
                    ) {
                        let _ = send_packet(&socket, address, &response);
                    }
                }
                prune(&mut received, DEDUP_TTL);
                let key = format!("{}:{}", address.ip(), packet.packet_no);
                if received.insert(key, (Instant::now(), ())).is_none() {
                    let text = packet.extra.trim_end_matches('\0').to_string();
                    let event = IpmsgMessageEvent {
                        id: blake3::hash(
                            format!("{}\0{}\0{}", record.peer.id, packet.packet_no, text)
                                .as_bytes(),
                        )
                        .to_hex()[..24]
                            .to_string(),
                        packet_no: packet.packet_no.clone(),
                        peer_id: record.peer.id.clone(),
                        user: record.peer.user.clone(),
                        host: record.peer.host.clone(),
                        nickname: record.peer.nickname.clone(),
                        text,
                        received_at: now_ms(),
                    };
                    let _ = app.emit("rocketx://ipmsg-message", event);
                    let offers = parse_file_offers(&packet, &record);
                    if let Ok(mut values) = incoming.lock() {
                        values.retain(|_, value| value.expires_at > Instant::now());
                        for offer in offers {
                            let event = offer.offer.clone();
                            values.insert(event.id.clone(), offer);
                            let _ = app.emit("rocketx://ipmsg-file-offer", event);
                        }
                    }
                }
            }
            continue;
        }
        if mode == IPMSG_BR_EXIT {
            let id = peer_id(address, &packet.user, &packet.host);
            let removed = peers.write().ok().and_then(|mut values| values.remove(&id));
            if let Some(record) = removed {
                let _ = app.emit(
                    "rocketx://ipmsg-peer",
                    IpmsgPeerEvent {
                        kind: "remove".to_string(),
                        peer: record.peer,
                    },
                );
            }
        }
    }
}

fn read_tcp_packet(stream: &mut TcpStream, local_port: u16) -> Result<Packet, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|error| format!("failed to configure IPMSG file socket: {error}"))?;
    let mut buffer = vec![0_u8; 4096];
    let length = stream
        .read(&mut buffer)
        .map_err(|error| format!("failed to read IPMSG file request: {error}"))?;
    parse_packet_for_port(&buffer[..length], local_port)
}

fn handle_tcp_connection(
    mut stream: TcpStream,
    address: SocketAddr,
    local_port: u16,
    outgoing: SharedOutgoing,
) -> Result<(), String> {
    let packet = read_tcp_packet(&mut stream, local_port)?;
    if packet.command & COMMAND_MASK != IPMSG_GETFILEDATA {
        return Err("IPMSG TCP command is unsupported".to_string());
    }
    let fields = packet.extra.split(':').collect::<Vec<_>>();
    if fields.len() < 3 {
        return Err("IPMSG file request is truncated".to_string());
    }
    let packet_no = u64::from_str_radix(fields[0], 16)
        .map_err(|_| "IPMSG file packet id is invalid".to_string())?
        .to_string();
    let file_id =
        u64::from_str_radix(fields[1], 16).map_err(|_| "IPMSG file id is invalid".to_string())?;
    let offset = u64::from_str_radix(fields[2], 16)
        .map_err(|_| "IPMSG file offset is invalid".to_string())?;
    let offer = {
        let mut offers = outgoing
            .lock()
            .map_err(|_| "IPMSG outgoing file store is unavailable".to_string())?;
        offers.retain(|_, offer| offer.expires_at > Instant::now());
        offers
            .values()
            .find(|offer| {
                offer.peer_ip == address.ip()
                    && offer.packet_no == packet_no
                    && offer.file_id == file_id
            })
            .cloned()
            .ok_or_else(|| "IPMSG file offer is unavailable".to_string())?
    };
    if offset > offer.size {
        return Err("IPMSG file offset exceeds the offered file".to_string());
    }
    let mut file = File::open(&offer.path)
        .map_err(|error| format!("failed to open IPMSG offered file: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("failed to seek IPMSG offered file: {error}"))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut remaining = offer.size - offset;
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = file
            .read(&mut buffer[..limit])
            .map_err(|error| format!("failed to read IPMSG offered file: {error}"))?;
        if read == 0 {
            return Err("IPMSG offered file ended unexpectedly".to_string());
        }
        stream
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed to stream IPMSG offered file: {error}"))?;
        remaining -= read as u64;
    }
    Ok(())
}

fn tcp_loop(
    listener: TcpListener,
    local_port: u16,
    outgoing: SharedOutgoing,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, address)) => {
                let outgoing = outgoing.clone();
                thread::spawn(move || {
                    let _ = handle_tcp_connection(stream, address, local_port, outgoing);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

fn stop_runtime(current: Option<IpmsgRuntime>) {
    let Some(current) = current else {
        return;
    };
    let _ = announce(
        &current.sockets[0].1,
        &current.identity,
        IPMSG_BR_EXIT,
        SocketAddr::from((Ipv4Addr::BROADCAST, current.sockets[0].0)),
    );
    for (port, socket) in current.sockets.iter().skip(1) {
        let _ = announce(
            socket,
            &current.identity,
            IPMSG_BR_EXIT,
            SocketAddr::from((Ipv4Addr::BROADCAST, *port)),
        );
    }
    current.stop.store(true, Ordering::Relaxed);
    for thread in current.threads {
        let _ = thread.join();
    }
}

fn take_runtime(state: &IpmsgRuntimeState) -> Result<Option<IpmsgRuntime>, String> {
    state
        .0
        .lock()
        .map_err(|_| "IPMSG runtime lock is unavailable".to_string())
        .map(|mut runtime| runtime.take())
}

fn bind_compatibility_ports(
    bind_ip: Ipv4Addr,
) -> Result<(Vec<(u16, Arc<UdpSocket>)>, Vec<(u16, TcpListener)>), String> {
    let mut sockets = Vec::new();
    let mut listeners = Vec::new();
    for port in [IPMSG_PORT, INTRANET_PORT] {
        let bound = (|| {
            let udp = UdpSocket::bind((bind_ip, port))
                .map_err(|error| format!("IPMSG UDP {port} is unavailable: {error}"))?;
            udp.set_broadcast(true)
                .and_then(|_| udp.set_read_timeout(Some(Duration::from_millis(500))))
                .map_err(|error| {
                    format!("failed to configure IPMSG UDP socket on {port}: {error}")
                })?;
            let listener = TcpListener::bind((bind_ip, port))
                .map_err(|error| format!("IPMSG TCP {port} is unavailable: {error}"))?;
            listener.set_nonblocking(true).map_err(|error| {
                format!("failed to configure IPMSG TCP listener on {port}: {error}")
            })?;
            Ok::<_, String>((Arc::new(udp), listener))
        })();
        match bound {
            Ok((socket, listener)) => {
                sockets.push((port, socket));
                listeners.push((port, listener));
            }
            Err(_) if port == INTRANET_PORT => {}
            Err(error) => return Err(error),
        }
    }
    Ok((sockets, listeners))
}

#[tauri::command]
pub fn ipmsg_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, IpmsgRuntimeState>,
    user_name: String,
    nickname: String,
    group: Option<String>,
) -> Result<IpmsgStatus, String> {
    stop_runtime(take_runtime(&state)?);
    let identity = Arc::new(IpmsgIdentity {
        user: sanitize_identity(&user_name, "rocketx"),
        host: host_name(),
        nickname: sanitize_identity(&nickname, &user_name),
        group: sanitize_identity(group.as_deref().unwrap_or("RocketX"), "RocketX"),
    });
    let bind_ip = std::env::var("ROCKETX_IPMSG_BIND")
        .ok()
        .and_then(|value| value.parse::<Ipv4Addr>().ok())
        .unwrap_or(Ipv4Addr::UNSPECIFIED);
    let (sockets, listeners) = bind_compatibility_ports(bind_ip)?;
    let intranet_available = sockets.iter().any(|(port, _)| *port == INTRANET_PORT);
    let peers = Arc::new(RwLock::new(HashMap::new()));
    let acks = Arc::new((Mutex::new(HashSet::new()), Condvar::new()));
    let outgoing = Arc::new(Mutex::new(HashMap::new()));
    let incoming = Arc::new(Mutex::new(HashMap::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();
    for (port, socket) in &sockets {
        let receiver = socket
            .try_clone()
            .map_err(|error| format!("failed to clone IPMSG UDP socket on {port}: {error}"))?;
        let app = app.clone();
        let identity = identity.clone();
        let peers = peers.clone();
        let acks = acks.clone();
        let outgoing = outgoing.clone();
        let incoming = incoming.clone();
        let stop = stop.clone();
        let local_port = *port;
        threads.push(thread::spawn(move || {
            udp_loop(
                app, receiver, local_port, identity, peers, acks, outgoing, incoming, stop,
            )
        }));
    }
    for (port, listener) in listeners {
        let outgoing = outgoing.clone();
        let stop = stop.clone();
        threads.push(thread::spawn(move || {
            tcp_loop(listener, port, outgoing, stop)
        }));
    }
    let runtime = IpmsgRuntime {
        stop,
        sockets: sockets.clone(),
        identity: identity.clone(),
        peers,
        acks,
        outgoing,
        incoming,
        threads,
    };
    *state
        .0
        .lock()
        .map_err(|_| "IPMSG runtime lock is unavailable".to_string())? = Some(runtime);
    for (port, socket) in &sockets {
        if let Err(error) = announce(
            socket,
            &identity,
            IPMSG_BR_ENTRY,
            SocketAddr::from((Ipv4Addr::BROADCAST, *port)),
        ) {
            stop_runtime(take_runtime(&state)?);
            return Err(error);
        }
    }
    if let Ok(value) = std::env::var("ROCKETX_IPMSG_PEER") {
        if let Ok(ip) = value.parse::<Ipv4Addr>() {
            for (port, socket) in &sockets {
                let _ = announce(
                    socket,
                    &identity,
                    IPMSG_BR_ENTRY,
                    SocketAddr::from((ip, *port)),
                );
            }
        }
    }
    Ok(IpmsgStatus {
        enabled: true,
        port: IPMSG_PORT,
        peer_count: 0,
        intranet_available,
    })
}

#[tauri::command]
pub fn ipmsg_stop(state: tauri::State<'_, IpmsgRuntimeState>) -> Result<(), String> {
    stop_runtime(take_runtime(&state)?);
    Ok(())
}

#[tauri::command]
pub fn ipmsg_status(state: tauri::State<'_, IpmsgRuntimeState>) -> Result<IpmsgStatus, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| "IPMSG runtime lock is unavailable".to_string())?;
    let Some(runtime) = runtime.as_ref() else {
        return Ok(IpmsgStatus {
            enabled: false,
            port: IPMSG_PORT,
            peer_count: 0,
            intranet_available: false,
        });
    };
    let peer_count = runtime.peers.read().map(|peers| peers.len()).unwrap_or(0);
    Ok(IpmsgStatus {
        enabled: true,
        port: IPMSG_PORT,
        peer_count,
        intranet_available: runtime
            .sockets
            .iter()
            .any(|(port, _)| *port == INTRANET_PORT),
    })
}

#[tauri::command]
pub fn ipmsg_peers(state: tauri::State<'_, IpmsgRuntimeState>) -> Result<Vec<IpmsgPeer>, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| "IPMSG runtime lock is unavailable".to_string())?;
    let Some(runtime) = runtime.as_ref() else {
        return Ok(Vec::new());
    };
    let mut peers = runtime
        .peers
        .write()
        .map_err(|_| "IPMSG peer store is unavailable".to_string())?;
    peers.retain(|_, peer| peer.last_seen.elapsed() <= PEER_TTL);
    let mut values = peers
        .values()
        .map(|record| record.peer.clone())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.nickname.cmp(&right.nickname));
    Ok(values)
}

fn udp_socket_for_peer(runtime: &IpmsgRuntime, peer: &PeerRecord) -> Arc<UdpSocket> {
    runtime
        .sockets
        .iter()
        .find(|(port, _)| *port == peer.local_port)
        .map(|(_, socket)| socket.clone())
        .unwrap_or_else(|| runtime.sockets[0].1.clone())
}

fn peer_snapshot(runtime: &IpmsgRuntime, peer_id: &str) -> Result<PeerRecord, String> {
    runtime
        .peers
        .read()
        .map_err(|_| "IPMSG peer store is unavailable".to_string())?
        .get(peer_id)
        .filter(|peer| peer.last_seen.elapsed() <= PEER_TTL)
        .cloned()
        .ok_or_else(|| "IPMSG peer is offline".to_string())
}

#[tauri::command]
pub async fn ipmsg_send_message(
    state: tauri::State<'_, IpmsgRuntimeState>,
    peer_id: String,
    text: String,
) -> Result<IpmsgSendReceipt, String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.len() > MAX_MESSAGE_BYTES {
        return Err("IPMSG message is empty or too long".to_string());
    }
    let (socket, identity, peer, acks) = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| "IPMSG runtime lock is unavailable".to_string())?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| "IPMSG compatibility is disabled".to_string())?;
        let peer = peer_snapshot(runtime, &peer_id)?;
        (
            udp_socket_for_peer(runtime, &peer),
            runtime.identity.clone(),
            peer,
            runtime.acks.clone(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let packet_no = next_packet_no();
        let utf8 = peer.peer.supports_utf8 && peer.dialect == Dialect::Standard;
        let command = IPMSG_SENDMSG | IPMSG_SENDCHECKOPT | if utf8 { IPMSG_UTF8OPT } else { 0 };
        let packet = build_packet(&identity, peer.dialect, &packet_no, command, &text, None)?;
        let acknowledged = wait_for_ack(&socket, &acks, peer.address, &packet_no, &packet)?;
        Ok(IpmsgSendReceipt {
            packet_no,
            acknowledged,
        })
    })
    .await
    .map_err(|error| format!("IPMSG send task failed: {error}"))?
}

fn escaped_file_name(value: &str) -> String {
    value.replace(':', "::")
}

#[tauri::command]
pub async fn ipmsg_offer_file(
    state: tauri::State<'_, IpmsgRuntimeState>,
    peer_id: String,
    path: String,
) -> Result<IpmsgFileOffer, String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve IPMSG source file: {error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to inspect IPMSG source file: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("IPMSG source must be a regular file no larger than 20 GiB".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "IPMSG source file name is invalid".to_string())?
        .to_string();
    safe_file_name(&file_name)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let (socket, identity, peer, acks, outgoing) = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| "IPMSG runtime lock is unavailable".to_string())?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| "IPMSG compatibility is disabled".to_string())?;
        let peer = peer_snapshot(runtime, &peer_id)?;
        (
            udp_socket_for_peer(runtime, &peer),
            runtime.identity.clone(),
            peer,
            runtime.acks.clone(),
            runtime.outgoing.clone(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let packet_no = next_packet_no();
        let file_id = 1_u64;
        let utf8 = peer.peer.supports_utf8 && peer.dialect == Dialect::Standard;
        let attachment = format!(
            "{file_id:x}:{}:{:x}:{modified_at:x}:1:\u{7}",
            escaped_file_name(&file_name),
            metadata.len()
        );
        let attachment = encode(&attachment, peer.dialect, utf8)?;
        let command = IPMSG_SENDMSG
            | IPMSG_SENDCHECKOPT
            | IPMSG_FILEATTACHOPT
            | if utf8 { IPMSG_UTF8OPT } else { 0 };
        let packet = build_packet(
            &identity,
            peer.dialect,
            &packet_no,
            command,
            &file_name,
            Some(&attachment),
        )?;
        let id = blake3::hash(format!("{}\0{}\0{}", peer.peer.id, packet_no, file_name).as_bytes())
            .to_hex()[..32]
            .to_string();
        outgoing
            .lock()
            .map_err(|_| "IPMSG outgoing file store is unavailable".to_string())?
            .insert(
                id.clone(),
                OutgoingOffer {
                    peer_ip: peer.address.ip(),
                    packet_no: packet_no.clone(),
                    file_id,
                    path,
                    size: metadata.len(),
                    expires_at: Instant::now() + OFFER_TTL,
                },
            );
        let acknowledged = wait_for_ack(&socket, &acks, peer.address, &packet_no, &packet)?;
        if !acknowledged {
            outgoing
                .lock()
                .map_err(|_| "IPMSG outgoing file store is unavailable".to_string())?
                .remove(&id);
            return Err("IPMSG peer did not acknowledge the file offer".to_string());
        }
        Ok(IpmsgFileOffer {
            id,
            peer_id: peer.peer.id,
            file_name,
            size: metadata.len(),
            modified_at,
        })
    })
    .await
    .map_err(|error| format!("IPMSG file offer task failed: {error}"))?
}

fn download_target(root: &Path, offer: &IpmsgFileOffer) -> Result<PathBuf, String> {
    safe_file_name(&offer.file_name)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("failed to prepare IPMSG download directory: {error}"))?;
    let mut target = root.join(&offer.file_name);
    if !target.exists() {
        return Ok(target);
    }
    let stem = Path::new(&offer.file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = Path::new(&offer.file_name)
        .extension()
        .and_then(|value| value.to_str());
    for index in 1..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        target = root.join(name);
        if !target.exists() {
            return Ok(target);
        }
    }
    Err("IPMSG download destination has too many collisions".to_string())
}

fn download_offer(
    identity: &IpmsgIdentity,
    root: &Path,
    incoming: &SharedIncoming,
    offer_id: &str,
) -> Result<IpmsgFileReceipt, String> {
    let offer = {
        let mut values = incoming
            .lock()
            .map_err(|_| "IPMSG incoming file store is unavailable".to_string())?;
        values.retain(|_, value| value.expires_at > Instant::now());
        values
            .get(offer_id)
            .cloned()
            .ok_or_else(|| "IPMSG file offer expired".to_string())?
    };
    let target = download_target(root, &offer.offer)?;
    let part = target.with_extension(format!(
        "{}.part",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
    ));
    let command = IPMSG_GETFILEDATA | if offer.utf8 { IPMSG_UTF8OPT } else { 0 };
    let candidates = [Some(offer.file_id), offer.alternate_file_id];
    let mut last_error = "IPMSG peer rejected the file request".to_string();
    for file_id in candidates.into_iter().flatten() {
        let mut stream = TcpStream::connect_timeout(&offer.address, Duration::from_secs(5))
            .map_err(|error| format!("failed to connect IPMSG file peer: {error}"))?;
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(5))))
            .map_err(|error| format!("failed to configure IPMSG download socket: {error}"))?;
        let request = build_packet(
            identity,
            offer.dialect,
            &next_packet_no(),
            command,
            &format!(
                "{:x}:{file_id:x}:0:",
                offer.packet_no.parse::<u64>().unwrap_or(0)
            ),
            None,
        )?;
        stream
            .write_all(&request)
            .map_err(|error| format!("failed to request IPMSG file: {error}"))?;
        let mut file = File::create(&part)
            .map_err(|error| format!("failed to create IPMSG partial file: {error}"))?;
        let mut remaining = offer.offer.size;
        let mut buffer = vec![0_u8; 1024 * 1024];
        while remaining > 0 {
            let limit = remaining.min(buffer.len() as u64) as usize;
            let read = stream
                .read(&mut buffer[..limit])
                .map_err(|error| format!("failed to download IPMSG file: {error}"))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|error| format!("failed to write IPMSG file: {error}"))?;
            remaining -= read as u64;
        }
        if remaining > 0 {
            drop(file);
            let received = offer.offer.size - remaining;
            let _ = fs::remove_file(&part);
            last_error = format!(
                "IPMSG file transfer ended after {received} of {} bytes",
                offer.offer.size
            );
            if received == 0 {
                continue;
            }
            return Err(last_error);
        }
        file.sync_all()
            .map_err(|error| format!("failed to flush IPMSG file: {error}"))?;
        drop(file);
        fs::rename(&part, &target)
            .map_err(|error| format!("failed to publish IPMSG file: {error}"))?;
        incoming
            .lock()
            .map_err(|_| "IPMSG incoming file store is unavailable".to_string())?
            .remove(offer_id);
        return Ok(IpmsgFileReceipt {
            offer_id: offer_id.to_string(),
            file_name: offer.offer.file_name.clone(),
            size: offer.offer.size,
            local_path: target.to_string_lossy().to_string(),
        });
    }
    Err(last_error)
}

#[tauri::command]
pub async fn ipmsg_download_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, IpmsgRuntimeState>,
    offer_id: String,
) -> Result<IpmsgFileReceipt, String> {
    let (identity, incoming) = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| "IPMSG runtime lock is unavailable".to_string())?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| "IPMSG compatibility is disabled".to_string())?;
        (runtime.identity.clone(), runtime.incoming.clone())
    };
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve IPMSG download directory: {error}"))?
        .join("ipmsg");
    tauri::async_runtime::spawn_blocking(move || {
        download_offer(&identity, &root, &incoming, &offer_id)
    })
    .await
    .map_err(|error| format!("IPMSG download task failed: {error}"))?
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<IpmsgRuntimeState>();
    if let Ok(current) = take_runtime(&state) {
        stop_runtime(current);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> IpmsgIdentity {
        IpmsgIdentity {
            user: "rocketx".to_string(),
            host: "desktop".to_string(),
            nickname: "RocketX".to_string(),
            group: "RocketX".to_string(),
        }
    }

    fn receive_mode(socket: &UdpSocket, expected: u32) -> (Packet, SocketAddr) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buffer = vec![0_u8; MAX_DATAGRAM_BYTES];
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for IPMSG mode {expected}"
            );
            match socket.recv_from(&mut buffer) {
                Ok((length, address)) => {
                    let packet = parse_packet(&buffer[..length]).unwrap();
                    if packet.command & COMMAND_MASK == expected {
                        return (packet, address);
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => panic!("failed to receive official IPMSG packet: {error}"),
            }
        }
    }

    #[test]
    fn standard_utf8_packet_round_trips() {
        let packet = build_packet(
            &identity(),
            Dialect::Standard,
            "123",
            IPMSG_SENDMSG | IPMSG_SENDCHECKOPT | IPMSG_UTF8OPT,
            "你好，IP Messenger",
            None,
        )
        .unwrap();
        let parsed = parse_packet(&packet).unwrap();
        assert_eq!(parsed.packet_no, "123");
        assert_eq!(parsed.command & COMMAND_MASK, IPMSG_SENDMSG);
        assert_eq!(parsed.extra, "你好，IP Messenger");
    }

    #[test]
    fn feiq_gbk_fixture_is_detected_without_executing_feiq() {
        let mut fixture = b"1_lbt6_8#998#FeiX#0#0#0#4001#9:1523368691537:def:TINCHER:288:".to_vec();
        fixture.extend_from_slice(&[0xba, 0xc3]);
        let parsed = parse_packet(&fixture).unwrap();
        assert_eq!(parsed.dialect, Dialect::Feiq);
        assert_eq!(parsed.command & COMMAND_MASK, IPMSG_SENDMSG);
        assert_eq!(parsed.extra, "好");
    }

    #[test]
    fn intranet_port_decodes_gbk_before_exposing_packet_fields() {
        let intranet_identity = IpmsgIdentity {
            user: "内网用户".to_string(),
            host: "研发电脑".to_string(),
            nickname: "内网通".to_string(),
            group: "研发组".to_string(),
        };
        let packet = build_packet(
            &intranet_identity,
            Dialect::Intranet,
            "456",
            IPMSG_SENDMSG | IPMSG_SENDCHECKOPT,
            "中文互通消息",
            None,
        )
        .unwrap();

        let parsed = parse_packet_for_port(&packet, INTRANET_PORT).unwrap();

        assert_eq!(parsed.dialect, Dialect::Intranet);
        assert_eq!(parsed.user, "内网用户");
        assert_eq!(parsed.host, "研发电脑");
        assert_eq!(parsed.extra, "中文互通消息");
    }

    #[test]
    #[ignore = "explicit loopback integration test"]
    fn intranet_gbk_message_round_trips_over_udp_loopback() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, INTRANET_PORT)).unwrap();
        receiver.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let intranet_identity = IpmsgIdentity {
            user: "内网用户".to_string(),
            host: "研发电脑".to_string(),
            nickname: "RocketX 内网通".to_string(),
            group: "研发组".to_string(),
        };

        announce(
            &sender,
            &intranet_identity,
            IPMSG_BR_ENTRY,
            receiver.local_addr().unwrap(),
        )
        .unwrap();
        let mut buffer = vec![0_u8; MAX_DATAGRAM_BYTES];
        let (length, address) = receiver.recv_from(&mut buffer).unwrap();
        let discovery = parse_packet_for_port(&buffer[..length], INTRANET_PORT).unwrap();
        let discovered_peer = peer_from_packet(&discovery, address, INTRANET_PORT);

        assert_eq!(discovery.dialect, Dialect::Intranet);
        assert_eq!(discovery.user, "内网用户");
        assert_eq!(discovery.host, "研发电脑");
        assert_eq!(discovered_peer.peer.nickname, "RocketX 内网通");
        assert_eq!(discovered_peer.peer.group, "研发组");

        let packet = build_packet(
            &intranet_identity,
            Dialect::Intranet,
            "789",
            IPMSG_SENDMSG | IPMSG_SENDCHECKOPT,
            "RocketX 本机 9011 互通验证",
            None,
        )
        .unwrap();

        sender
            .send_to(&packet, receiver.local_addr().unwrap())
            .unwrap();
        let (length, _) = receiver.recv_from(&mut buffer).unwrap();
        let parsed = parse_packet_for_port(&buffer[..length], INTRANET_PORT).unwrap();

        assert_eq!(parsed.dialect, Dialect::Intranet);
        assert_eq!(parsed.extra, "RocketX 本机 9011 互通验证");
    }

    #[test]
    #[ignore = "explicit fixed-port integration test"]
    fn occupied_intranet_port_keeps_ipmsg_listener_available() {
        let _blocked_udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, INTRANET_PORT)).unwrap();
        let _blocked_tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, INTRANET_PORT)).unwrap();

        let (sockets, listeners) = bind_compatibility_ports(Ipv4Addr::LOCALHOST).unwrap();
        let socket_ports = sockets.iter().map(|(port, _)| *port).collect::<Vec<_>>();
        let listener_ports = listeners.iter().map(|(port, _)| *port).collect::<Vec<_>>();

        assert_eq!(socket_ports, vec![IPMSG_PORT]);
        assert_eq!(listener_ports, vec![IPMSG_PORT]);
    }

    #[test]
    fn packet_rejects_truncation_invalid_number_and_oversize() {
        assert!(parse_packet(b"1:2:user").is_err());
        assert!(parse_packet(b"1:nope:user:host:32:hello").is_err());
        assert!(parse_packet(&vec![b'a'; MAX_DATAGRAM_BYTES + 1]).is_err());
    }

    #[test]
    fn file_offer_parses_regular_file_and_rejects_traversal() {
        let address = SocketAddr::from(([127, 0, 0, 2], IPMSG_PORT));
        let base = Packet {
            packet_no: "123".to_string(),
            user: "alice".to_string(),
            host: "desktop".to_string(),
            command: IPMSG_SENDMSG | IPMSG_FILEATTACHOPT | IPMSG_UTF8OPT,
            extra: "file".to_string(),
            attachment: b"1:report.txt:400:1:1:\x07".to_vec(),
            dialect: Dialect::Standard,
        };
        let record = peer_from_packet(&base, address, IPMSG_PORT);
        let offers = parse_file_offers(&base, &record);
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].offer.file_name, "report.txt");
        assert_eq!(offers[0].offer.size, 0x400);
        assert_eq!(
            parse_file_id("631870475"),
            Some((631_870_475, Some(0x631870475)))
        );

        let mut traversal = base;
        traversal.attachment = b"1:..\\secret.txt:10:1:1:\x07".to_vec();
        assert!(parse_file_offers(&traversal, &record).is_empty());
    }

    #[test]
    fn message_ack_retries_stop_after_real_udp_receipt() {
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let address = receiver.local_addr().unwrap();
        let acks = Arc::new((Mutex::new(HashSet::new()), Condvar::new()));
        let ack_writer = acks.clone();
        let server = thread::spawn(move || {
            let mut buffer = [0_u8; 1024];
            let (length, source) = receiver.recv_from(&mut buffer).unwrap();
            let packet = parse_packet(&buffer[..length]).unwrap();
            let (lock, condition) = &*ack_writer;
            lock.lock()
                .unwrap()
                .insert(ack_key(source, &packet.packet_no));
            condition.notify_all();
        });
        let packet = build_packet(
            &identity(),
            Dialect::Standard,
            "456",
            IPMSG_SENDMSG | IPMSG_SENDCHECKOPT | IPMSG_UTF8OPT,
            "hello",
            None,
        )
        .unwrap();
        assert!(wait_for_ack(&sender, &acks, address, "456", &packet).unwrap());
        server.join().unwrap();
    }

    #[test]
    fn file_offer_streams_exact_bytes_over_real_tcp() {
        let content = b"RocketX IPMSG file interoperability".repeat(4096);
        let source = std::env::temp_dir().join(format!(
            "rocketx-ipmsg-{}-{}.bin",
            std::process::id(),
            next_packet_no()
        ));
        fs::write(&source, &content).unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let outgoing = Arc::new(Mutex::new(HashMap::from([(
            "offer".to_string(),
            OutgoingOffer {
                peer_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                packet_no: "123".to_string(),
                file_id: 1,
                path: source.clone(),
                size: content.len() as u64,
                expires_at: Instant::now() + Duration::from_secs(5),
            },
        )])));
        let server_offers = outgoing.clone();
        let server = thread::spawn(move || {
            let (stream, peer) = listener.accept().unwrap();
            handle_tcp_connection(stream, peer, IPMSG_PORT, server_offers).unwrap();
        });
        let mut client = TcpStream::connect(address).unwrap();
        let request = build_packet(
            &identity(),
            Dialect::Standard,
            "789",
            IPMSG_GETFILEDATA | IPMSG_UTF8OPT,
            "7b:1:0",
            None,
        )
        .unwrap();
        client.write_all(&request).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut received = Vec::new();
        client.read_to_end(&mut received).unwrap();
        server.join().unwrap();
        fs::remove_file(source).unwrap();
        assert_eq!(received, content);
    }

    #[test]
    #[ignore = "requires ROCKETX_IPMSG_OFFICIAL_DIR pointing to extracted official IP Messenger 5.x"]
    fn official_ipmsg_5x_message_and_file_interoperate() {
        let official_dir = PathBuf::from(
            std::env::var("ROCKETX_IPMSG_OFFICIAL_DIR")
                .expect("ROCKETX_IPMSG_OFFICIAL_DIR is required"),
        );
        let ipmsg = official_dir.join("IPMsg.exe");
        let ipcmd = official_dir.join("ipcmd.exe");
        assert!(ipmsg.is_file() && ipcmd.is_file());

        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, IPMSG_PORT)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut official = std::process::Command::new(&ipmsg)
            .args(["/NIC", "127.0.0.2"])
            .current_dir(&official_dir)
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_secs(2));

        let me = identity();
        let entry = build_packet(
            &me,
            Dialect::Standard,
            &next_packet_no(),
            IPMSG_BR_ENTRY | IPMSG_CAPUTF8OPT | IPMSG_UTF8OPT | IPMSG_FILEATTACHOPT,
            &entry_extra(&me),
            None,
        )
        .unwrap();
        socket
            .send_to(&entry, (Ipv4Addr::new(127, 0, 0, 2), IPMSG_PORT))
            .unwrap();
        let (answer, official_address) = receive_mode(&socket, IPMSG_ANSENTRY);
        assert_eq!(
            official_address.ip(),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
        );
        assert_eq!(
            peer_from_packet(&answer, official_address, IPMSG_PORT)
                .peer
                .dialect,
            "ipmsg"
        );
        let list = std::process::Command::new(&ipcmd)
            .args(["/nic=127.0.0.2", "list"])
            .current_dir(&official_dir)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&list.stdout).contains("RocketX"));

        let outbound_packet_no = next_packet_no();
        let outbound = build_packet(
            &me,
            Dialect::Standard,
            &outbound_packet_no,
            IPMSG_SENDMSG | IPMSG_SENDCHECKOPT | IPMSG_UTF8OPT,
            "RocketX to official IP Messenger 5.x acceptance",
            None,
        )
        .unwrap();
        socket.send_to(&outbound, official_address).unwrap();
        let (receipt, _) = receive_mode(&socket, IPMSG_RECVMSG);
        assert_eq!(receipt.extra, outbound_packet_no);

        let message = "RocketX official IP Messenger 5.x acceptance";
        let output = std::process::Command::new(&ipcmd)
            .args(["/nic=127.0.0.2", "send", "/noseal", "127.0.0.1", message])
            .current_dir(&official_dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "ipcmd send failed: {:?}", output);
        let (packet, address) = receive_mode(&socket, IPMSG_SENDMSG);
        assert_eq!(packet.extra, message);
        let ack = build_packet(
            &me,
            packet.dialect,
            &next_packet_no(),
            IPMSG_RECVMSG
                | if packet.command & IPMSG_UTF8OPT != 0 {
                    IPMSG_UTF8OPT
                } else {
                    0
                },
            &packet.packet_no,
            None,
        )
        .unwrap();
        socket.send_to(&ack, address).unwrap();

        let source =
            std::env::temp_dir().join(format!("rocketx-official-source-{}.bin", next_packet_no()));
        let expected_file_name = source.file_name().unwrap().to_string_lossy().to_string();
        let download_root =
            std::env::temp_dir().join(format!("rocketx-official-download-{}", next_packet_no()));
        let content = b"Official IP Messenger file transfer".repeat(32768);
        fs::write(&source, &content).unwrap();
        let file_arg = format!("/file={}", source.to_string_lossy());
        let output = std::process::Command::new(&ipcmd)
            .args([
                "/nic=127.0.0.2",
                "send",
                &file_arg,
                "/noseal",
                "127.0.0.1",
                "file acceptance",
            ])
            .current_dir(&official_dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "ipcmd file send failed: {:?}",
            output
        );
        let (packet, offers) = loop {
            let (candidate, candidate_address) = receive_mode(&socket, IPMSG_SENDMSG);
            let ack = build_packet(
                &me,
                candidate.dialect,
                &next_packet_no(),
                IPMSG_RECVMSG
                    | if candidate.command & IPMSG_UTF8OPT != 0 {
                        IPMSG_UTF8OPT
                    } else {
                        0
                    },
                &candidate.packet_no,
                None,
            )
            .unwrap();
            socket.send_to(&ack, candidate_address).unwrap();
            if candidate.command & IPMSG_FILEATTACHOPT != 0 {
                let record = peer_from_packet(&candidate, candidate_address, IPMSG_PORT);
                let candidate_offers = parse_file_offers(&candidate, &record);
                if candidate_offers
                    .iter()
                    .any(|offer| offer.offer.file_name == expected_file_name)
                {
                    break (candidate, candidate_offers);
                }
            }
        };
        assert_eq!(offers.len(), 1, "official packet: {packet:?}");
        let parsed_file_id = offers[0].file_id;
        let offer_id = offers[0].offer.id.clone();
        let incoming = Arc::new(Mutex::new(HashMap::from([(
            offer_id.clone(),
            offers.into_iter().next().unwrap(),
        )])));
        let receipt =
            download_offer(&me, &download_root, &incoming, &offer_id).unwrap_or_else(|error| {
                panic!("{error}; parsed_file_id={parsed_file_id}; packet={packet:?}")
            });
        assert_eq!(fs::read(&receipt.local_path).unwrap(), content);

        let _ = std::process::Command::new(&ipcmd)
            .args(["/nic=127.0.0.2", "terminate"])
            .current_dir(&official_dir)
            .output();
        thread::sleep(Duration::from_millis(500));
        if official.try_wait().ok().flatten().is_none() {
            let _ = official.kill();
        }
        let _ = fs::remove_file(source);
        let _ = fs::remove_dir_all(download_root);
    }
}
