import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { SpeechCaptureGate, type CaptureState } from '@/lib/speechCapture';
import {
  decodeRecordedWakeWord, getHouseholdVoiceStatus, POSITIVE_MINIMUM,
  synchronizeHouseholdVoice, UNKNOWN_MINIMUM, uploadHouseholdSample,
  validVoiceWords, voiceKey, type HouseholdVoiceStatus, type HouseholdVoiceWord,
} from '@/lib/householdVoiceTraining';

interface Props {
  householdId: string;
  words: HouseholdVoiceWord[];
}

export default function HouseholdVoiceTraining({ householdId, words }: Props) {
  const [status, setStatus] = useState<HouseholdVoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [capturePhase, setCapturePhase] = useState<CaptureState>('waiting');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const cancelCapture = useRef<(() => void) | null>(null);
  const active = useRef(true);
  const manifest = words.map(w => `${w.id}:${w.phrase}`).sort().join('|');
  const eligible = validVoiceWords(words);
  const hasSavedPhrase = eligible.length > 0;

  const refresh = useCallback(async () => {
    if (!validVoiceWords(words).length) return;
    setBusy(true);
    setError('');
    try {
      const synced = await synchronizeHouseholdVoice(householdId, words);
      if (active.current) setStatus(synced);
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }, [householdId, manifest]);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      cancelCapture.current?.();
    };
  }, [refresh]);

  const stop = () => cancelCapture.current?.();

  const start = async (wordId: string, phrase: string) => {
    if (busy || recording || !hasSavedPhrase || (wordId !== 'unknown' && !eligible.some(word => word.id === wordId))) return;
    setError('');
    setMessage('');
    setCapturePhase('waiting');
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let interval: ReturnType<typeof setInterval> | null = null;
    let media: MediaRecorder | undefined;
    let released = false;
    let saveCapture = false;

    const release = () => {
      if (released) return;
      released = true;
      if (interval !== null) clearInterval(interval);
      interval = null;
      if (context) void context.close().catch(() => {});
      stream?.getTracks().forEach(track => track.stop());
      cancelCapture.current = null;
      if (active.current) setRecording(null);
    };
    const finish = (save: boolean) => {
      saveCapture = save;
      if (media?.state === 'recording') media.stop();
      release(); // The microphone is disabled immediately, before file processing.
    };

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined'
          || typeof AudioContext === 'undefined') {
        throw new Error('Automatic microphone recording requires the MSDS desktop app or a supported browser.');
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (!active.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const pcm = new Float32Array(analyser.fftSize);
      const gate = new SpeechCaptureGate();
      const startedAt = performance.now();
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type));
      media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const parts: Blob[] = [];
      media.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      media.onstop = async () => {
        release();
        if (!saveCapture || !active.current) return;
        setBusy(true);
        try {
          if (!parts.length) throw new Error('No speech was recorded.');
          const wav = await decodeRecordedWakeWord(new Blob(parts, { type: media!.mimeType }));
          await uploadHouseholdSample(householdId, wordId, wav);
          const next = await getHouseholdVoiceStatus();
          if (active.current) {
            setStatus(next);
            setMessage(`Sample saved for "${phrase}".`);
          }
        } catch (e) {
          if (active.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (active.current) setBusy(false);
        }
      };
      cancelCapture.current = () => finish(false);
      setRecording(wordId);
      media.start();
      interval = setInterval(() => {
        if (released) return;
        analyser.getFloatTimeDomainData(pcm);
        let power = 0;
        for (const sample of pcm) power += sample * sample;
        const rms = Math.sqrt(power / pcm.length);
        const result = gate.update(rms, performance.now() - startedAt);
        if (result === 'speaking') setCapturePhase('speaking');
        if (result === 'captured') {
          finish(true);
        } else if (result === 'timeout' || result === 'too_short' || result === 'too_long') {
          setError(result === 'timeout'
            ? 'No speech detected. Try recording again.'
            : result === 'too_short'
              ? 'The word was too short or unclear. Please repeat it.'
              : 'The recording was too long. Say one short word or phrase.');
          finish(false); // Never enroll a timed-out or incomplete sample.
        }
      }, 40);
    } catch (e) {
      if (media?.state === 'recording') media.stop();
      release();
      if (active.current) {
        setError(e instanceof Error ? e.message : String(e));
        setRecording(null);
      }
    }
  };

  const trainingRows = [
    ...eligible.map(word => ({ ...word, key: voiceKey(word.phrase)!, required: POSITIVE_MINIMUM })),
    { id: 'unknown', phrase: 'Non-keyword speech (unknown)', key: 'unknown', required: UNKNOWN_MINIMUM },
  ];

  if (!hasSavedPhrase) return null;

  return (
    <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-4" data-testid="household-voice-training">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-bold flex items-center gap-2"><Mic className="h-4 w-4" /> Household voice training</h4>
        <button type="button" aria-label="Sync household voice training" title="Sync from household"
          onClick={() => void refresh()} disabled={busy || !!recording}
          className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="space-y-2">
        {trainingRows.map(word => {
          const count = status?.keywords[word.key] ?? 0;
          const ready = count >= word.required;
          return (
            <div key={word.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm break-words">{word.phrase}</div>
                <div className="text-xs text-muted-foreground">
                  {count} / {word.required} samples {ready ? '· Minimum reached' : '· More recordings needed'}
                </div>
              </div>
              {ready && <ShieldCheck className="h-4 w-4 text-success" aria-label="Minimum reached" />}
              {recording === word.id ? (
                <button type="button" onClick={stop}
                  className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground">
                  <MicOff className="h-4 w-4" /> Cancel
                </button>
              ) : (
                <button type="button" disabled={busy || !!recording}
                  onClick={() => void start(word.id, word.phrase)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                  <Mic className="h-4 w-4" /> {count ? 'Add sample' : 'Record'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {words.length !== eligible.length && (
        <p className="text-xs text-amber-600">
          Some phrases cannot be trained. Voice phrases must be 2–32 English letters, digits, spaces or hyphens
          and start with a letter. "911" and duplicate pronunciations are excluded.
        </p>
      )}
      {recording && <p role="status" className="text-xs text-primary animate-pulse">
        {capturePhase === 'speaking' ? 'Speech detected — release will be automatic.' : 'Listening… say the selected phrase once.'}
      </p>}
      {busy && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Processing household voice samples…</p>}
      {message && <p role="status" className="text-xs text-success">{message}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {status && <p className="text-xs font-medium">{status.open_set_ready ? 'Voice training ready' : 'Training incomplete'}</p>}
    </div>
  );
}
