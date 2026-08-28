//! LAN wire contract: handshake transcript and framed protocol messages.

use std::io::{Read, Write};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

const PROTOCOL_CONTEXT: &[u8] = b"rocketx-lan-handshake-v1";
pub(crate) const PROTOCOL_VERSION: u16 = 1;
pub(crate) const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandshakePeer {
    pub user_id: String,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandshakeTranscript {
    pub server_fingerprint: String,
    pub initiator: HandshakePeer,
    pub responder: HandshakePeer,
    pub initiator_nonce: String,
    pub responder_nonce: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ControlFrame {
    Hello {
        version: u16,
        peer: HandshakePeer,
        nonce: String,
    },
    Proof {
        signature: String,
    },
    Probe {
        request_id: String,
        signature: String,
    },
    ProbeAck {
        request_id: String,
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
        output.extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.extend_from_slice(value.as_bytes());
    }
    output
}

pub(crate) fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &HandshakeTranscript,
) -> String {
    URL_SAFE_NO_PAD.encode(signing_key.sign(&transcript_bytes(transcript)).to_bytes())
}

pub(crate) fn verify_transcript(
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

pub(crate) fn write_control_frame(
    writer: &mut impl Write,
    frame: &ControlFrame,
) -> Result<(), String> {
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

pub(crate) fn read_control_frame(reader: &mut impl Read) -> Result<ControlFrame, String> {
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

#[cfg(test)]
mod tests {
    use super::{read_control_frame, write_control_frame, ControlFrame, HandshakePeer};
    use std::io::Cursor;

    #[test]
    fn framed_protocol_round_trips() {
        let frame = ControlFrame::Hello {
            version: super::PROTOCOL_VERSION,
            peer: HandshakePeer {
                user_id: "u".into(),
                device_id: "d".into(),
                public_key: "k".into(),
            },
            nonce: "n".into(),
        };
        let mut bytes = Vec::new();
        write_control_frame(&mut bytes, &frame).unwrap();
        assert_eq!(read_control_frame(&mut Cursor::new(bytes)).unwrap(), frame);
    }
}
