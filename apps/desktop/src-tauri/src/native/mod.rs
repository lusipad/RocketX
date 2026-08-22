//! Native host primitives shared by runtime adapters.
//!
//! Product-specific lifecycle and IPC contracts remain in `proc`, `dsh`, and
//! `lan`; this module only owns process construction details that must behave
//! consistently across adapters.

pub(crate) mod codex;
pub(crate) mod codex_runtime;
pub(crate) mod dsh;
pub(crate) mod dsh_runtime;
pub(crate) mod host;
pub(crate) mod lan;
pub(crate) mod lan_identity;
pub(crate) mod lan_protocol;
pub(crate) mod process;
pub(crate) mod supervisor;
