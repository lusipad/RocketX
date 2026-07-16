import { useEffect } from 'react';
import { diagnosticErrorSummary, writeDiagnostic } from '../lib/diagnostics';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';

export default function DiagnosticBridge() {
  const authStatus = useAuth((state) => state.status);
  const connection = useChat((state) => state.connection);

  useEffect(() => {
    void writeDiagnostic('info', 'app', 'renderer started');
    const onError = (event: ErrorEvent) => {
      void writeDiagnostic('error', 'renderer', diagnosticErrorSummary(event.error ?? event.message));
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      void writeDiagnostic('error', 'renderer', diagnosticErrorSummary(event.reason));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useEffect(() => {
    void writeDiagnostic('info', 'auth', `status=${authStatus}`);
  }, [authStatus]);

  useEffect(() => {
    void writeDiagnostic('info', 'chat', `connection=${connection}`);
  }, [connection]);

  return null;
}
