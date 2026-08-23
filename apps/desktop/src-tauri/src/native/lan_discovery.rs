//! LAN identity and discovery contracts.
//!
//! Keychain persistence and discovery announcements are kept separate from
//! the TCP transport so protocol lifecycle code cannot redefine account scope
//! or peer identity rules.

use std::{
    collections::HashMap,
    net::Ipv4Addr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::lan_identity;
use super::lan_protocol::{HandshakePeer, PROTOCOL_VERSION};

pub(crate) const KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.lan";
pub(crate) const SERVICE_TYPE: &str = "_rcx._tcp.local.";
pub(crate) const UDP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 82, 67);
pub(crate) const UDP_PORT: u16 = 45_826;
pub(crate) const PEER_TTL_MS: u64 = 15_000;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanAnnouncement {
    pub(crate) version: u16,
    pub(crate) server_fingerprint: String,
    pub(crate) user_id: String,
    pub(crate) device_id: String,
    pub(crate) device_name: String,
    pub(crate) port: u16,
    pub(crate) public_key: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct StoredIdentity {
    pub(crate) device_id: String,
    pub(crate) secret_key: String,
}

pub(crate) struct RuntimeIdentity {
    pub(crate) peer: HandshakePeer,
    pub(crate) device_name: String,
    pub(crate) server_fingerprint: String,
    pub(crate) signing_key: SigningKey,
}

pub(crate) type PeerKey = (String, String);

pub(crate) fn server_fingerprint(server_url: &str) -> Result<String, String> {
    lan_identity::server_fingerprint(server_url)
}

fn identity_account(server_url: &str, user_id: &str) -> Result<String, String> {
    lan_identity::account_key(server_url, user_id)
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

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn peer_key(user_id: &str, device_id: &str) -> PeerKey {
    (user_id.to_string(), device_id.to_string())
}

pub(crate) fn random_nonce() -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

pub(crate) fn announcement_from_identity(identity: &RuntimeIdentity, port: u16) -> LanAnnouncement {
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

pub(crate) fn trusted_map(devices: Vec<TrustedDevice>) -> Result<HashMap<PeerKey, String>, String> {
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

pub(crate) fn build_runtime_identity(
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
