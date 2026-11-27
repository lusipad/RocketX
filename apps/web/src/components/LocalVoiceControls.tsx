import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { isTauriRuntime } from '../lib/http';
import {
  encodeLocalVoiceWav,
  localVoiceBase64,
  localVoiceError,
  LOCAL_VOICE_MAX_RECORDING_BYTES,
  LOCAL_VOICE_MAX_SECONDS,
  selectLocalVoiceEngine,
} from '../lib/localVoiceAudio';
import { cancelLocalVoice, probeLocalVoice, synthesizeLocalVoice, transcribeLocalVoice, type LocalVoiceCapabilities } from '../platform/localVoice';
import { useAuth } from '../stores/auth';
import { useLocalVoice } from '../stores/localVoice';

type Phase = 'idle' | 'checking' | 'requesting' | 'recording' | 'transcribing' | 'synthesizing' | 'playing';

export default function LocalVoiceControls({ targetKey, onTranscript, replyText = '', disabled = false }: {
  targetKey: string;
  onTranscript: (text: string) => void;
  replyText?: string;
  disabled?: boolean;
}) {
  const enabled = useLocalVoice((state) => state.enabled);
  const account = useAuth((state) => `${state.status}:${state.user?._id ?? ''}`);
  const identity = `${account}:${targetKey}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const holding = useRef(false);
  const stream = useRef<MediaStream>();
  const recorder = useRef<MediaRecorder>();
  const decoder = useRef<AudioContext>();
  const playback = useRef<HTMLAudioElement>();
  const audioUrl = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const nativeRequest = useRef<string>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [capabilities, setCapabilities] = useState<LocalVoiceCapabilities>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { locale, t } = useI18n();
  const desktop = isTauriRuntime();
  const matchedRecognizer = selectLocalVoiceEngine(capabilities?.recognizers, locale);
  const matchedVoice = selectLocalVoiceEngine(capabilities?.voices, locale);
  const canRecognize = Boolean(matchedRecognizer);
  const canSpeak = Boolean(matchedVoice);

  const stopResources = useCallback(() => {
    const requestId = nativeRequest.current;
    nativeRequest.current = undefined;
    if (requestId) void cancelLocalVoice(requestId).catch(() => {});
    holding.current = false;
    clearTimeout(timer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = undefined;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = undefined;
    if (decoder.current) void decoder.current.close().catch(() => {});
    decoder.current = undefined;
    if (playback.current) {
      playback.current.pause();
      playback.current.removeAttribute('src');
      playback.current.load();
    }
    playback.current = undefined;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = undefined;
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    stopResources();
    setPhase('idle');
  }, [stopResources]);

  // Every operation captures both account and recipient. Rendering a new target
  // invalidates late results even before effect cleanup runs.
  const valid = (token: number, owner: string) => generation.current === token && identityRef.current === owner && useLocalVoice.getState().enabled;

  const check = async () => {
    cancel();
    const token = generation.current;
    const owner = identity;
    setPhase('checking'); setError(''); setNotice('');
    const requestId = crypto.randomUUID();
    nativeRequest.current = requestId;
    try {
      const result = await probeLocalVoice(requestId);
      if (!valid(token, owner)) return;
      setCapabilities(result);
      if (!result.available) setError(result.reason || t('voice.noLocalComponent'));
    } catch (reason) {
      if (valid(token, owner)) setError(localVoiceError(reason));
    } finally {
      if (nativeRequest.current === requestId) nativeRequest.current = undefined;
      if (valid(token, owner)) setPhase('idle');
    }
  };

  useEffect(() => {
    if (!enabled) { cancel(); return; }
    void check();
    return cancel;
    // Probing happens once after explicit opt-in, never in a background loop.
  }, [enabled]);

  useEffect(() => {
    const stopOnBlur = () => cancel();
    const stopWhenHidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', stopOnBlur);
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => {
      generation.current += 1;
      stopResources();
      window.removeEventListener('blur', stopOnBlur);
      document.removeEventListener('visibilitychange', stopWhenHidden);
    };
  }, [cancel, stopResources]);

  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    cancel(); setCapabilities(undefined); setError(''); setNotice('');
    useLocalVoice.getState().setEnabled(false);
  }, [identity, cancel]);

  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);

  const finishRecording = () => {
    holding.current = false;
    clearTimeout(timer.current);
    if (recorder.current?.state === 'recording') {
      setPhase('transcribing');
      recorder.current.stop();
    } else cancel();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = undefined;
  };

  const startRecording = async () => {
    if (holding.current || disabled || phase !== 'idle' || !canRecognize) return;
    cancel();
    const token = generation.current;
    const owner = identity;
    const acceptTranscript = onTranscript;
    holding.current = true;
    setPhase('requesting'); setError(''); setNotice('');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error(t('voice.noWebViewRecording'));
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (!valid(token, owner) || !holding.current) { microphone.getTracks().forEach((track) => track.stop()); return; }
      stream.current = microphone;
      const capture = new MediaRecorder(microphone);
      recorder.current = capture;
      const chunks: Blob[] = [];
      let size = 0;
      capture.ondataavailable = (event) => {
        if (!valid(token, owner)) return;
        size += event.data.size;
        if (size > LOCAL_VOICE_MAX_RECORDING_BYTES) { cancel(); setError(t('voice.recordingTooLarge')); return; }
        chunks.push(event.data);
      };
      capture.onerror = () => { if (valid(token, owner)) { cancel(); setError(t('voice.micRecordFailed')); } };
      capture.onstop = () => {
        if (!valid(token, owner)) return;
        void (async () => {
          try {
            setPhase('transcribing');
            const context = new AudioContext();
            decoder.current = context;
            const audio = await context.decodeAudioData(await new Blob(chunks, { type: capture.mimeType }).arrayBuffer());
            if (!valid(token, owner)) return;
            const wav = encodeLocalVoiceWav(Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index)), audio.sampleRate);
            await context.close();
            if (decoder.current === context) decoder.current = undefined;
            if (!valid(token, owner)) return;
            const requestId = crypto.randomUUID();
            nativeRequest.current = requestId;
            const result = await transcribeLocalVoice(
              localVoiceBase64(wav),
              requestId,
              matchedRecognizer?.language,
            ).finally(() => {
              if (nativeRequest.current === requestId) nativeRequest.current = undefined;
            });
            if (!valid(token, owner)) return;
            if (!result.text.trim()) throw new Error(t('voice.noSpeechRecognized'));
            acceptTranscript(result.text.trim());
            setNotice(t('voice.transcribedNotice'));
          } catch (reason) {
            if (valid(token, owner)) setError(localVoiceError(reason));
          } finally {
            if (valid(token, owner)) { stopResources(); setPhase('idle'); }
          }
        })();
      };
      capture.start(250);
      setPhase('recording');
      timer.current = setTimeout(() => { if (valid(token, owner)) finishRecording(); }, LOCAL_VOICE_MAX_SECONDS * 1000);
    } catch (reason) {
      if (valid(token, owner)) { cancel(); setError(localVoiceError(reason)); }
    }
  };

  const speak = async () => {
    if (phase !== 'idle' || !replyText.trim() || !canSpeak || !capabilities) return;
    cancel();
    const token = generation.current;
    const owner = identity;
    setPhase('synthesizing'); setError(''); setNotice('');
    try {
      const requestId = crypto.randomUUID();
      nativeRequest.current = requestId;
      const result = await synthesizeLocalVoice(
        [...replyText].slice(0, 300).join(''),
        requestId,
        matchedVoice?.id,
        matchedVoice?.language,
      ).finally(() => {
        if (nativeRequest.current === requestId) nativeRequest.current = undefined;
      });
      if (!valid(token, owner)) return;
      if (result.mimeType !== 'audio/wav' || result.audioBase64.length > 16 * 1024 * 1024) throw new Error(t('voice.invalidAudioOutput'));
      const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
      audioUrl.current = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(audioUrl.current);
      playback.current = audio;
      audio.onended = () => { if (valid(token, owner)) { stopResources(); setPhase('idle'); } };
      audio.onerror = () => { if (valid(token, owner)) { cancel(); setError(t('voice.playbackFailed')); } };
      await audio.play();
      if (valid(token, owner)) setPhase('playing');
    } catch (reason) {
      if (valid(token, owner)) { cancel(); setError(localVoiceError(reason)); }
    }
  };

  if (!desktop) return <span className="text-xs text-ink-3">{t('voice.desktopOnly')}</span>;
  if (!enabled) return <button type="button" className="text-xs text-ink-3"
    onClick={() => useLocalVoice.getState().setEnabled(true)}
    onKeyDown={(event) => { if (event.key === ' ') { event.preventDefault(); useLocalVoice.getState().setEnabled(true); } }}
    onKeyUp={(event) => { if (event.key === ' ') event.preventDefault(); }}
  >{t('voice.enable')}</button>;
  const busy = phase !== 'idle';
  return (
    <section aria-label={t('voice.controlsLabel')} className="local-voice-controls flex flex-wrap items-center gap-2 px-1 py-2 text-xs">
      <span className="text-ink-3">{t('voice.hint')}</span>
      <button type="button" disabled={disabled || (busy && phase !== 'recording' && phase !== 'requesting') || !canRecognize}
        aria-label={t('voice.holdToSpeak')} aria-pressed={phase === 'recording'}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void startRecording(); }}
        onPointerUp={finishRecording} onPointerCancel={cancel} onLostPointerCapture={() => { if (holding.current) cancel(); }}
        onKeyDown={(event) => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void startRecording(); } }}
        onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finishRecording(); } }}
        onBlur={() => { if (holding.current) cancel(); }}
      >{phase === 'recording' ? t('voice.releaseToFinish') : phase === 'requesting' ? t('voice.requestingMic') : t('voice.holdToSpeak')}</button>
      <button type="button" disabled={busy || !replyText.trim() || !canSpeak} onClick={() => void speak()}>{[...replyText].length > 300 ? t('voice.readLatestTruncated') : t('voice.readLatest')}</button>
      <button type="button" disabled={!busy} onClick={cancel}>{t('voice.stopVoice')}</button>
      {phase === 'idle' && (!capabilities?.available || error) ? <button type="button" onClick={() => void check()}>{t('voice.recheck')}</button> : null}
      <button type="button" onClick={() => { cancel(); useLocalVoice.getState().setEnabled(false); }}>{t('voice.disable')}</button>
      <span role="status">{phase === 'checking' ? t('voice.checking') : phase === 'transcribing' ? t('voice.transcribing') : phase === 'synthesizing' ? t('voice.synthesizing') : phase === 'playing' ? t('voice.playing') : notice}</span>
      {capabilities && !canRecognize ? <span className="text-ink-3">{t('voice.recognizerUnavailable')}</span> : null}
      {capabilities && !canSpeak ? <span className="text-ink-3">{t('voice.speakerUnavailable')}</span> : null}
      {error ? <span role="alert">{error}</span> : null}
    </section>
  );
}
