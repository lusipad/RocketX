use std::sync::atomic::{AtomicBool, Ordering};

/// Native composition root. Tauri commands stay in their compatibility
/// modules, while process ownership and shutdown ordering live here.
#[derive(Default)]
pub(crate) struct NativeHost {
    shutdown_started: AtomicBool,
}

impl NativeHost {
    pub(crate) fn shutdown(&self, app: &tauri::AppHandle) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        crate::native_service::shutdown(app);
        crate::proc::shutdown(app);
        crate::dsh::shutdown(app);
        crate::lan::shutdown(app);
    }

    #[cfg(test)]
    fn claim_shutdown(&self) -> bool {
        !self.shutdown_started.swap(true, Ordering::AcqRel)
    }
}

#[cfg(test)]
mod tests {
    use super::NativeHost;

    #[test]
    fn shutdown_is_idempotent() {
        let host = NativeHost::default();
        assert!(host.claim_shutdown());
        assert!(!host.claim_shutdown());
    }
}
