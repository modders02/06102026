import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Maximize2, Mic, MicOff, RefreshCw, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { useCctvTalk } from '@/hooks/useCctvTalk';
import { useCameraSession } from '@/lib/cameraSessions';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { captureCameraEventSnapshot } from '@/lib/cameraEventSnapshot';
import { HAPPY_SMILE_MIN_ACTIVATION, shouldRecordSignificantEvent } from '@/lib/significantEvents';
import ValidationLayer from '@/components/dashboard/ValidationLayer';
import MotionTraceOverlay from '@/components/multicam/MotionTraceOverlay';
import { formatWakeWordDecision } from '@/lib/wakeWordValidation';
import { describeKwsCaptureHealth, explainKwsDuration, recentKwsDecision } from '@/lib/kwsLiveDiagnostics';
import type { CameraConfig, DetectionEvent, MultiCamSettings } from '@/types/multicam';

function statusIsOnline(runtime: { status?: string } | null) {
  return runtime?.status === 'online';
}

interface Props {
  camera: CameraConfig;
  settings: MultiCamSettings;
  onExpand?: (id: string) => void;
  onConnect: () => void;
}

/** Mounts the monitoring session's video, keeping a single stream and AI pipeline per camera. */
export default function LiveCameraFeed({ camera, settings, onExpand, onConnect }: Props) {
  const { video, runtime, home, reconnect } = useCameraSession(camera.id);
  const { addEvent } = useCameraRegistry();
  const lastSmilingHistoryAt = useRef(new Map<string, number>());
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [speaker, setSpeaker] = useState(false);
  // Smile geometry is supporting visual HISTORY context, never emergency
  // validation. Face-api's separate classifier can still read "Neutral" when
  // MediaPipe sees clear bilateral mouth-corner movement, so record this cue
  // independently instead of relying on the old face-api emotion label.
  const onFaceMovement = useCallback((observation: import('@/lib/facialMovementCues').FacialMovementObservation | null) => {
    if (!camera.aiEnabled || observation?.kind !== 'smile'
        || observation.activation < HAPPY_SMILE_MIN_ACTIVATION) return;
    const event: Omit<DetectionEvent, 'id'> = {
      cameraId: camera.id,
      cameraName: camera.name,
      location: camera.location,
      type: 'emotion',
      label: 'Happy',
      confidence: observation.activation,
      timestamp: new Date().toISOString(),
    };
    if (!shouldRecordSignificantEvent(event, lastSmilingHistoryAt.current)) return;
    addEvent({
      ...event,
      id: crypto.randomUUID(),
      snapshot: captureCameraEventSnapshot(camera.id),
    });
  }, [addEvent, camera.id, camera.name, camera.location, camera.aiEnabled]);
  const tracingActive = !!video && statusIsOnline(runtime) && camera.aiEnabled;
  // The object detector already found a real person in the camera frame.
  // Search the person's upper area at higher resolution to locate an actual
  // distant face. A PERSON box alone is never displayed as a FACE box.
  const trackedPerson = (runtime?.objects ?? [])
    .filter(object => object.label === 'person' && object.confidence >= 0.55)
    .sort((a, b) => b.confidence - a.confidence)[0];
  const sourceWidth = runtime?.frameWidth || 320;
  const sourceHeight = runtime?.frameHeight || (video?.videoWidth
    ? Math.max(1, Math.round(video.videoHeight / video.videoWidth * sourceWidth))
    : 180);
  const personRegion = trackedPerson && sourceWidth > 0 && sourceHeight > 0
    ? {
        x: trackedPerson.bbox[0] / sourceWidth,
        y: trackedPerson.bbox[1] / sourceHeight,
        width: trackedPerson.bbox[2] / sourceWidth,
        height: trackedPerson.bbox[3] / sourceHeight,
      }
    : null;
  const talk = useCctvTalk(settings.pythonServer, camera.id);
  const stopTalk = talk.stopTalk;
  const status = runtime?.status || 'connecting';
  const customKeywordMode = runtime?.audio?.recognition_engine === 'custom';
  const kws = runtime?.audio?.custom_kws;
  const captureHealth = describeKwsCaptureHealth(
    runtime?.audio ?? null, runtime?.audioBackendReachable !== false,
  );
  const freshDecision = recentKwsDecision(
    runtime?.audio ?? null, runtime?.audioBackendReachable !== false,
  );
  // The backend keeps the precise reason for testing, but the live camera
  // presents accepted voice recognition using one friendly green label.
  // This does not imply that face/visual alert fusion has also passed.
  const kwsAccepted = freshDecision
    && ['accepted', 'accepted_help_90', 'verified', 'verified_help_rescue']
      .includes(kws?.last_decision || '');
  const diagnosticTone = captureHealth.severity === 'error'
    ? 'bg-destructive/10 text-destructive'
    : kwsAccepted ? 'bg-success/10 text-success'
      : freshDecision && kws?.last_decision ? 'text-amber-500'
        : 'text-muted-foreground';
  const diagnosticLabel = captureHealth.severity === 'error'
    ? 'MIC UNAVAILABLE'
    : kwsAccepted ? 'ACCEPTED'
      : freshDecision && kws?.last_decision === 'verification_pending'
        ? 'CHECKING'
        : freshDecision && kws?.last_decision ? 'NOT CONFIRMED' : 'WAITING';
  const diagnosticReason = captureHealth.state !== 'streaming'
    ? captureHealth.message
    : freshDecision ? formatWakeWordDecision(kws?.last_decision)
      : 'Listening — no recent keyword decision.';
  const pct = (value?: number) => typeof value === 'number'
    ? `${(value * 100).toFixed(1)}%`
    : '—';
  const num = (value?: number, digits = 4) => typeof value === 'number'
    ? value.toFixed(digits)
    : '—';
  const customSpeechText = customKeywordMode && freshDecision && kws?.last_candidate
    ? kwsAccepted
      ? (kws.last_keyword || kws.last_candidate)
      : `Candidate: ${kws.last_candidate} (${pct(kws.last_candidate_confidence)}) · ${formatWakeWordDecision(kws.last_decision || 'verification_pending')}`
    : '';
  // Never display a cached accepted word while live camera audio has stopped.
  const speechText = customKeywordMode
    ? (captureHealth.state === 'streaming' && freshDecision ? customSpeechText || runtime?.transcript || '' : '')
    : runtime?.transcript || '';

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !video) return;
    const originalParent = home || video.parentElement;
    const originalStyle = video.style.cssText;
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;';
    video.playsInline = true;
    container.appendChild(video);
    void video.play().catch(() => { /* Existing session will retry playback when the stream becomes ready. */ });
    return () => {
      if (video.parentElement === container) {
        video.muted = true;
        video.style.cssText = originalStyle;
        if (originalParent?.isConnected) originalParent.appendChild(video);
        else video.remove();
      }
    };
  }, [video, home]);

  useEffect(() => {
    if (video) video.muted = !speaker;
    return () => { if (video) video.muted = true; };
  }, [speaker, video]);

  useEffect(() => stopTalk, [stopTalk]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!runtime || !camera.aiEnabled) return;
    const sx = canvas.width / (runtime.frameWidth || 320);
    const sy = canvas.height / (runtime.frameHeight || Math.max(1, Math.round((video.videoHeight / video.videoWidth) * 320)));
    ctx.lineWidth = 3;
    ctx.font = '600 16px Inter, sans-serif';
    for (const object of runtime.objects) {
      const [x, y, width, height] = object.bbox;
      ctx.strokeStyle = object.label === 'person' ? 'hsl(150 90% 50%)' : 'hsl(190 90% 55%)';
      ctx.strokeRect(x * sx, y * sy, width * sx, height * sy);
      const label = `${object.label} ${(object.confidence * 100).toFixed(0)}%`;
      const textWidth = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x * sx, Math.max(0, y * sy - 22), textWidth, 22);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x * sx + 5, Math.max(17, y * sy - 6));
    }
    if (runtime.fire.detected && runtime.fire.bbox) {
      const [x, y, width, height] = runtime.fire.bbox;
      ctx.strokeStyle = 'hsl(0 90% 55%)';
      ctx.lineWidth = 4;
      ctx.strokeRect(x * sx, y * sy, width * sx, height * sy);
    }
  }, [runtime, video, camera.aiEnabled]);

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{camera.name}</h2>
          <p className="truncate text-xs text-muted-foreground">{camera.location || camera.id}</p>
        </div>
        <div className="flex items-center gap-1">
          <span className={`mr-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${status === 'online' ? 'bg-success/15 text-success' : status === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status === 'online' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}</span>
          {customKeywordMode && (
            <span data-testid="camera-microphone-badge" title={captureHealth.message}
              className={`mr-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${captureHealth.severity === 'ok'
                ? 'bg-success/10 text-success'
                : captureHealth.severity === 'error'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted text-muted-foreground'}`}>
              {captureHealth.state === 'streaming' ? 'Mic live'
                : captureHealth.state === 'warming-up' ? 'Mic connecting'
                  : 'Mic offline'}
            </span>
          )}
          <button onClick={() => setSpeaker(value => !value)} title={speaker ? 'Mute camera sound' : 'Hear camera sound'} aria-label={speaker ? 'Mute camera sound' : 'Hear camera sound'} aria-pressed={speaker} className={`rounded-lg p-2 hover:bg-muted ${speaker ? 'text-primary' : 'text-muted-foreground'}`}>{speaker ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</button>
          <button
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void talk.startTalk(); }}
            onPointerUp={talk.stopTalk}
            onPointerCancel={talk.stopTalk}
            onLostPointerCapture={talk.stopTalk}
            onKeyDown={event => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); void talk.startTalk(); } }}
            onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); talk.stopTalk(); } }}
            onBlur={talk.stopTalk}
            title="Hold to talk through this camera"
            aria-label="Hold to talk through this camera"
            aria-pressed={talk.talking}
            className={`touch-none rounded-lg p-2 hover:bg-muted ${talk.talking ? 'text-destructive' : 'text-muted-foreground'}`}
          >{talk.talking ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}</button>
          {reconnect && <button onClick={reconnect} title="Reconnect camera" aria-label="Reconnect camera" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><RefreshCw className="h-4 w-4" /></button>}
          {onExpand && <button onClick={() => onExpand(camera.id)} title="Open camera" aria-label={`Open ${camera.name}`} className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><Maximize2 className="h-4 w-4" /></button>}
        </div>
      </div>
      <div className="relative aspect-video bg-black">
        <div ref={containerRef} className="absolute inset-0" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        {tracingActive && video && <MotionTraceOverlay video={video} modes={{ face: true, body: false, hands: false }} detail="outline" personRegion={personRegion} onMovement={onFaceMovement} />}
        {status !== 'online' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 px-6 text-center">
            <VideoOff className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-semibold">{status === 'connecting' ? 'Connecting to live feed…' : runtime?.error || 'Device offline'}</p>
            {status !== 'connecting' && <button onClick={onConnect} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-muted">Connection settings</button>}
          </div>
        )}
        {talk.error && <div role="alert" className="absolute right-3 top-3 max-w-[80%] rounded-lg bg-destructive px-3 py-2 text-xs text-destructive-foreground">{talk.error}</div>}
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-primary">
            <Mic className="h-3.5 w-3.5" />
            {customKeywordMode ? 'Safety keyword detection' : 'Live transcription'}
          </span>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="min-w-0 flex-1 truncate text-sm text-foreground"
            title={speechText || (customKeywordMode ? diagnosticReason : runtime?.audioMessage) || 'Listening…'}
          >
            {speechText || (
              <span className={captureHealth.severity === 'error' || runtime?.audioTone === 'error'
                ? 'text-destructive' : 'text-muted-foreground'}>
                {customKeywordMode ? captureHealth.message : runtime?.audioMessage || 'Listening…'}
              </span>
            )}
          </p>
        </div>
      </div>
      {runtime?.validation && (
        <div className="border-t border-border bg-muted/10 px-4 py-2.5" data-testid="fusion-validation">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-foreground">
              Validation: {runtime.validation.ready ? (runtime.validation.flags.length ? 'Degraded' : 'Ready') : 'Insufficient input'}
            </span>
            <span className="font-mono text-muted-foreground">
              α {runtime.attentionScore}/100 · V {runtime.saliencyScore} · A {runtime.audioIntensityScore ?? 0} · O {runtime.objectRelevanceScore ?? 0}
            </span>
          </div>
          {runtime.validation.flags.length > 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {runtime.validation.flags.join(' · ')}
            </p>
          )}
          {runtime.motionAnomaly?.detected && (
            <p className="mt-1 text-xs font-semibold text-destructive">
              Validated motion anomaly: {runtime.motionAnomaly.label}
            </p>
          )}
        </div>
      )}
      {kws && (
        <div className="border-t border-border bg-muted/20 px-4 py-3" data-testid="voice-diagnostics">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-foreground">Voice diagnostics</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${diagnosticTone}`}>
              {diagnosticLabel}
            </span>
          </div>
          <div data-testid="cctv-audio-health" role="status"
            className={`mb-2 rounded-md border px-3 py-2 text-xs ${captureHealth.severity === 'ok'
              ? 'border-success/30 text-success'
              : captureHealth.severity === 'error'
                ? 'border-destructive/30 text-destructive'
                : 'border-border text-muted-foreground'}`}>
            <span className="font-semibold">{captureHealth.message}</span>
            <span className="ml-2 opacity-85">
              · Source: {runtime?.audio?.audio_source || 'unknown'}
              · Last probed codec: {runtime?.audio?.audio_codec || 'unknown'}
              · PCM: {(runtime?.audio?.bytes_received ?? 0).toLocaleString()} bytes
            </span>
          </div>
          <p data-testid="kws-active-profiles" className="mb-2 text-xs text-muted-foreground">
            Hearing: <span className="font-semibold text-foreground">{kws.hearing_profile || 'unknown'}</span>
            {' · '}Noise: <span className="font-semibold text-foreground">{kws.audio_noise_profile || 'unknown'}</span>
            {' · '}VAD: <span className="font-semibold text-foreground">{kws.vad_backend || 'unknown'}</span>
            {' · '}Neural: <span className="font-semibold text-foreground">{kws.neural_mode || 'unknown'}</span>
            {kws.publisher_noise_profile && kws.publisher_noise_profile !== 'off' && (
              <>{' · '}Playback filter: <span className="font-semibold text-foreground">{kws.publisher_noise_profile}</span></>
            )}
            {kws.neural_mode === 'shadow' && ' (comparison only; DTW decides alerts)'}
          </p>
          <p className="mb-2 text-xs text-muted-foreground">{diagnosticReason}</p>
          {freshDecision && kws.last_decision === 'duration_mismatch' && (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400" data-testid="kws-duration-explanation">
              {explainKwsDuration(kws.last_decision, kws.last_duration_ratio)}
            </p>
          )}
          {!freshDecision && kws.last_candidate && (
            <p className="mb-2 text-xs text-muted-foreground" data-testid="kws-previous-decision">
              Previous result only: {kws.last_candidate} ({formatWakeWordDecision(kws.last_decision)})
              {kws.last_segment_at && Number.isFinite(Date.parse(kws.last_segment_at))
                ? ` · ${new Date(kws.last_segment_at).toLocaleTimeString()}` : ''}
            </p>
          )}
          {kws.neural_mode === 'shadow' && kws.neural_last_error && (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
              Neural comparison unavailable: {kws.neural_last_error}
            </p>
          )}
          {kws.language_scope && (
            <p className="mb-2 text-xs text-muted-foreground">
              Scope: <span className="font-semibold text-foreground">English only</span>
              {kws.active_keywords?.length ? ` · ${kws.active_keywords.join(', ')}` : ''}
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <span className="text-muted-foreground">Segment</span>
            <span className="font-mono text-foreground">{kws.last_segment_ms ? `${kws.last_segment_ms} ms` : '—'}</span>
            <span className="text-muted-foreground">Candidate</span>
            <span className="font-mono text-foreground">{kws.last_candidate || '—'} {kws.last_candidate ? `(${pct(kws.last_candidate_confidence)})` : ''}</span>

            <span className="text-muted-foreground">Runner-up</span>
            <span className="font-mono text-foreground">{kws.last_runner_up_keyword || '—'} {kws.last_runner_up_keyword ? `(${pct(kws.last_runner_up_confidence)})` : ''}</span>
            <span className="text-muted-foreground">Unknown</span>
            <span className="font-mono text-foreground">{pct(kws.last_negative_confidence)}</span>

            <span className="text-muted-foreground">Class margin</span>
            <span className="font-mono text-foreground">{num(kws.last_class_margin)} / {num(kws.last_required_margin)}</span>
            <span className="text-muted-foreground">Duration ratio</span>
            <span className="font-mono text-foreground">{num(kws.last_duration_ratio, 3)}</span>

            <span className="text-muted-foreground">Last accepted keyword</span>
            <span className="font-mono text-foreground">{kws.last_keyword || '—'}</span>
            <span className="text-muted-foreground">Processing</span>
            <span className="font-mono text-foreground">{typeof kws.last_processing_ms === 'number' ? `${kws.last_processing_ms.toFixed(1)} ms` : '—'}</span>
          </div>
        </div>
      )}
      <div className="border-t border-border px-4 py-3">
        <ValidationLayer cameraId={camera.id} cameraName={camera.name} />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" />{camera.aiEnabled ? 'AI monitoring on' : 'AI monitoring off'}</span>
        {runtime?.status === 'online' && <span className="font-mono">{runtime.transport === 'webrtc' || runtime.transport === 'local' ? 'Realtime · ' : ''}{runtime.fps} FPS</span>}
      </div>
      {runtime?.playbackWarning && <p role="status" className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{runtime.playbackWarning}</p>}
    </article>
  );
}
