//! LAN file-transfer state and integrity rules.
//!
//! The transport facade owns TCP connections and command orchestration. This
//! module owns resumable manifests, partial files, chunk validation, and the
//! final integrity-checked receive event.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::{
    lan::{safe_file_name, transfer_paths},
    lan_protocol::{HandshakePeer, PROTOCOL_VERSION},
};

pub const CHUNK_BYTES: u32 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanFileEvent {
    pub(crate) from_user_id: String,
    pub(crate) from_device_id: String,
    pub(crate) message_id: String,
    pub(crate) room_id: String,
    pub(crate) original_ts: i64,
    pub(crate) file_name: String,
    pub(crate) size: u64,
    pub(crate) blake3: String,
    pub(crate) local_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct IncomingTransfer {
    pub(crate) version: u16,
    pub(crate) transfer_id: String,
    pub(crate) from_user_id: String,
    pub(crate) from_device_id: String,
    pub(crate) message_id: String,
    pub(crate) room_id: String,
    pub(crate) original_ts: i64,
    pub(crate) file_name: String,
    pub(crate) size: u64,
    pub(crate) chunk_bytes: u32,
    pub(crate) chunk_count: u64,
    pub(crate) blake3: String,
    pub(crate) received: Vec<bool>,
}

pub(crate) type SharedTransfers = Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>>;

pub(crate) fn valid_transfer_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn valid_blake3(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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

pub(crate) fn incoming_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve LAN receive directory: {error}"))?
        .join("lan-incoming");
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to prepare LAN receive directory: {error}"))?;
    Ok(root)
}

pub(crate) fn hash_file(path: &Path) -> Result<String, String> {
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

pub(crate) fn prepare_file_offer(
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

pub(crate) fn write_file_chunk(
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

pub(crate) fn finish_file_transfer(
    root: &Path,
    peer: &HandshakePeer,
    transfers: &SharedTransfers,
    transfer_id: &str,
    deliver: impl FnOnce(LanFileEvent) -> Result<(), String>,
) -> Result<(), String> {
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
    let delivered_path = manifest_path.with_extension("delivered");
    if delivered_path.exists() {
        return Ok(());
    }
    deliver(LanFileEvent {
        from_user_id: peer.user_id.clone(),
        from_device_id: peer.device_id.clone(),
        message_id: transfer.message_id,
        room_id: transfer.room_id,
        original_ts: transfer.original_ts,
        file_name: transfer.file_name,
        size: transfer.size,
        blake3: transfer.blake3,
        local_path: final_path.to_string_lossy().to_string(),
    })?;
    fs::write(&delivered_path, [])
        .map_err(|error| format!("failed to record LAN file delivery: {error}"))
}
