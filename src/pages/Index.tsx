import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Moon, Sun, Home, LogOut, Shield, Wifi, X, Flame, HelpCircle, Menu, Sparkles, Mic } from 'lucide-react';
import DashboardCameraCard from '@/components/dashboard/DashboardCameraCard';
import CameraMonitor from '@/components/dashboard/CameraMonitor';
import Monitoring from '@/pages/Monitoring';
import ControlsPanel from '@/components/dashboard/ControlsPanel';
import AttentionGauge from '@/components/dashboard/AttentionGauge';
import DetectionFeedback from '@/components/dashboard/DetectionFeedback';
import TutorialOverlay, { type TutorialStep } from '@/components/dashboard/TutorialOverlay';
import ExpertMode, { type AlgorithmId } from '@/components/dashboard/ExpertMode';
import AccessibilityPanel from '@/components/dashboard/AccessibilityPanel';
import MultiCameraConnect from '@/components/dashboard/MultiCameraConnect';
import { setHintsSuppressed } from '@/components/IdleHint';
import { useCamera } from '@/hooks/useCamera';
import { useAudioAnalysis } from '@/hooks/useAudioAnalysis';
import { useYamnet } from '@/hooks/useYamnet';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useAuth } from '@/hooks/useAuth';
import { useHousehold } from '@/hooks/useHousehold';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { loadServerHost, serverUrlFor, useCameraSlots, type SlotCount } from '@/hooks/useCameraSlots';
import { useCameraSlotConnections } from '@/hooks/useCameraSlotConnections';
import { useWakeLock } from '@/hooks/useWakeLock';
import { announce } from '@/lib/voiceGuide';
import { sendAlertEmail } from '@/lib/alertEmail';
import { stopAll as stopAllCameras, stopCamera } from '@/lib/multiCamServer';
import { matchWakeWord } from '@/lib/safetyLexicon';
import {
  audioEventScore,
  audioIntensityScoreFromDb,
  computeAttentionScore,
  objectRelevanceScore,
} from '@/lib/attentionFusion';
import { makeFireSpeechSignal } from '@/lib/fireFusion';
import { makeDistressSpeechSignal } from '@/lib/multimodalDistress';
import { captureCameraEventSnapshot } from '@/lib/cameraEventSnapshot';
import { getCameraSession } from '@/lib/cameraSessions';
import { clipFileName, recordClip, saveClip } from '@/lib/clipRecorder';
import { classifyPriorityScenario, isPriorityCameraAlert } from '@/lib/priorityScenario';
import type { CameraRuntime, DetectionEvent } from '@/types/multicam';
import { isSignificantHistoryEvent, isIndependentVisualHistoryEvent, shouldRecordSignificantEvent } from '@/lib/significantEvents';
import type { Alert, QualityMode } from '@/types/dashboard';
import { DEFAULT_PRIORITY_OBJECTS } from '@/types/dashboard';

const monitoringSession = { running: false };

const ALGORITHM_TOURS: Record<AlgorithmId, TutorialStep[]> = {
  vision: [
    {
      selector: '#tour-fused-view', placement: 'bottom', title: 'Visual saliency',
      body: 'Each camera frame is changed to grayscale. Sobel edges or frame-to-frame motion reveal the parts that deserve attention.',
      implementation: 'src/lib/saliency.ts',
      code: `const saliency = computeSaliency(frame, previousFrame, 'sobel', 40);\nconst score = computeSaliencyScore(saliency);`,
    },
    {
      selector: '#tour-fused-view', placement: 'bottom', title: 'Object detection',
      body: 'COCO-SSD with MobileNet v2 identifies people and common objects. A confidence threshold removes uncertain boxes.',
      implementation: 'src/lib/detectionEngine.ts',
      code: `const predictions = await model.detect(frame, 20, minimumConfidence);`,
    },
  ],
  fire: [
    {
      selector: '#tour-fire-analysis', placement: 'top', title: 'Fire and smoke analysis',
      body: 'A fire alert requires an accepted “fire” keyword and current, detector-confirmed large fire covering at least 10% of the camera frame. Visual-only fire and smoke detections continue updating Event history.',
      implementation: 'src/lib/fireDetection.ts',
      code: `if (confirmedLargeFire && acceptedFireWithin10s) alert();`,
    },
  ],
  face: [
    {
      selector: '#tour-face-distress', placement: 'top', title: 'Facial distress',
      body: 'Facial expressions never alarm by themselves. Help, danger, intruder, and police require Angry/Frightened; emergency requires Frightened; ambulance requires Sad/Frightened. Each accepted word must match the same camera within four seconds.',
      implementation: 'src/hooks/useFaceDistress.ts',
      code: `alert = fuse(matchingExpression, acceptedKeyword, 4_000);`,
    },
  ],
  speech: [
    {
      selector: '#tour-live-transcription', placement: 'bottom', title: 'Trained safety keyword detection',
      body: 'Sound comes from the CCTV RTSP stream. FFmpeg converts it to 16 kHz mono PCM, then the trained custom KWS engine evaluates speech segments against the enrolled safety-word templates.',
      implementation: 'local-server/msds/camera.py · local-server/msds/kws_engine.py',
      code: `RTSP audio → 16 kHz PCM → VAD → log-Mel + DTW → trained keyword decision`,
    },
    {
      selector: '#tour-live-transcription', placement: 'bottom', title: 'Safety phrase matching',
      body: 'Only accepted trained safety keywords are published. Each facial keyword requires its configured expression. “Fire” requires a large, detector-confirmed fire in the current camera frame.',
      implementation: 'src/lib/safetyLexicon.ts',
      code: `if (matchingExpression && acceptedKeyword && within4Seconds) raiseVerifiedAlert();`,
    },
  ],
  audio: [
    {
      selector: '#tour-audio-distress', placement: 'top', title: 'Sound distress',
      body: 'YAMNet examines short sound windows and scores safety sounds such as screaming, crying, shouting, and wailing while suppressing ordinary sounds.',
      implementation: 'src/hooks/useYamnet.ts',
      code: `distress = weightedSafetySounds - 0.5 * ordinarySounds;`,
    },
  ],
  hybrid: [
    {
      selector: '#tour-fused-view', placement: 'bottom', title: '1. Observe every signal',
      body: 'The multimodal system watches visual saliency and objects while the trained custom KWS listens for enrolled safety keywords. It also checks faces, fire, smoke, visibility, and distress sounds.',
      implementation: 'src/hooks/useCameraPipeline.ts',
      code: `vision + objects + sound + speech + face + fire + smoke`,
    },
    {
      selector: '#tour-saliency-score', placement: 'top', title: '2. Combine attention',
      body: 'The attention score combines visual saliency, audio activity, and object confidence. Camera alerts require an accepted keyword and matching camera evidence.',
      implementation: 'src/pages/Index.tsx',
      code: `attention = 0.40*visual + 0.30*audio + 0.30*objects;`,
    },
    {
      selector: '#tour-cams', placement: 'bottom', title: '3. Review the result',
      body: 'Accepted audio and matching camera evidence produce one alert with its exact trigger snapshot. Use a camera’s Events button to review alerts, ongoing detections, and recording updates on the Cameras page.',
      implementation: 'src/pages/Index.tsx · src/components/dashboard/DashboardEvents.tsx',
      code: `if (acceptedAudio && acceptedCameraEvidence) addAlert(event);`,
    },
  ],
};


/** Camera monitoring persists across routes; browser video exists only in the live view. */
export default function Index() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const liveView = location.pathname === '/cameras';
  const requestedCamera = searchParams.get('camera');
  const { events, settings, addEvent, updateEvent, updateSettings } = useCameraRegistry();
  const { householdId, checkForWakeWord, logAlert, logNotification } = useHousehold(user?.id);
  const { cameras, devices, startCameras, stopCameras, enumerateDevices } = useCamera();
  const { count, slots, setCount, updateSlot } = useCameraSlots();
  useCameraSlotConnections(slots, updateSlot);
  const { audioFeatures, startAudio, stopAudio } = useAudioAnalysis();
  const speech = useSpeechRecognition();
  const { start: startSpeech, stop: stopSpeech, clear: clearSpeech, supported: speechSupported } = speech;
  const [running, setRunningState] = useState(monitoringSession.running);
  const setRunning = useCallback((value: boolean) => {
    monitoringSession.running = value;
    setRunningState(value);
  }, []);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('safewatch-dark-mode') === 'true');
  const [showIpDialog, setShowIpDialog] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showEmergency, setShowEmergency] = useState(false);
  const [showExpert, setShowExpert] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialOverride, setTutorialOverride] = useState<TutorialStep[] | null>(null);
  const [runtimes, setRuntimes] = useState<Record<number, CameraRuntime>>({});
  const [cameraError, setCameraError] = useState('');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [quality, setQuality] = useState<QualityMode>('SD');
  const [mirror, setMirror] = useState(false);
  const [heatmapOpacity, setHeatmapOpacity] = useState(50);
  const [simulationMode, setSimulationMode] = useState(false);
  const [priorityObjects, setPriorityObjects] = useState<string[]>(DEFAULT_PRIORITY_OBJECTS);
  const alertCooldown = useRef(new Map<string, number>());
  const lastLocalSpeechTrigger = useRef<number | null>(null);
  const recordingCameras = useRef(new Set<string>());
  const lastSignificantHistoryAt = useRef(new Map<string, number>());
  const householdMatches = useRef(new Map<number, { phrase: string; at: number }>());
  const previousConnections = useRef(new Set<number>());
  const connected = slots.filter(slot => slot.connected);
  const localCameras = cameras.filter(camera => camera.active && camera.stream);
  const localAudioEnabled = running && localCameras.length > 0 && connected.length === 0;
  const yamnet = useYamnet(localAudioEnabled);
  const pipelineSettings = useMemo(() => ({ ...settings, priorityObjects }), [settings, priorityObjects]);
  const currentRuntime = runtimes[selectedCamera];
  const focusedLiveCamera = slots.some(slot => `slot-${slot.index}` === requestedCamera) ? requestedCamera : null;
  const localAudioScore = audioEventScore(
    audioFeatures.audioEvent,
    audioIntensityScoreFromDb(audioFeatures.decibel),
  );
  const localObjectScore = objectRelevanceScore(currentRuntime?.objects ?? [], priorityObjects);
  const attention = selectedCamera === 1 && localAudioEnabled
    ? computeAttentionScore(currentRuntime?.saliencyScore ?? 0, localAudioScore, localObjectScore)
    : currentRuntime?.attentionScore ?? 0;
  const saliency = currentRuntime?.saliencyScore ?? 0;
  const eventCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) {
      if (!isSignificantHistoryEvent(event)) continue;
      counts.set(event.cameraId, (counts.get(event.cameraId) || 0) + 1);
    }
    return counts;
  }, [events]);
  useWakeLock(running || connected.length > 0);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('safewatch-dark-mode', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    void enumerateDevices();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const refresh = () => { void enumerateDevices(); };
    media.addEventListener('devicechange', refresh);
    return () => media.removeEventListener('devicechange', refresh);
  }, [enumerateDevices]);

  useEffect(() => {
    setHintsSuppressed(running || connected.length > 0);
    return () => setHintsSuppressed(false);
  }, [running, connected.length]);

  const openConnection = useCallback((index: number) => {
    if (index > count) setCount(index as SlotCount);
    setSelectedCamera(index);
    setShowIpDialog(true);
  }, [count, setCount]);

  useEffect(() => {
    if (liveView) return;
    const index = Number(searchParams.get('connect'));
    if (index >= 1 && index <= 4) openConnection(index);
    const eventCamera = searchParams.get('events');
    if (eventCamera) navigate(`/cameras?camera=${encodeURIComponent(eventCamera)}&events=${encodeURIComponent(eventCamera)}`, { replace: true });
  }, [searchParams, liveView, openConnection, navigate]);

  const closeConnection = () => {
    setShowIpDialog(false);
    if (searchParams.has('connect')) {
      const next = new URLSearchParams(searchParams);
      next.delete('connect');
      setSearchParams(next, { replace: true });
    }
  };

  useEffect(() => {
    const current = new Set(slots.filter(slot => slot.connected).map(slot => slot.index));
    const added = [...current].some(index => !previousConnections.current.has(index));
    previousConnections.current = current;
    if (added) { setRunning(true); setCameraError(''); }
  }, [slots, setRunning]);

  const storeEvent = useCallback((event: Omit<DetectionEvent, 'id'>) => {
    // Keep the Event History strictly incident-based. This is also the
    // centralized gate for dashboard, backend audio and local microphone.
    // Non-significant observations still update live detection metrics.
    if (!shouldRecordSignificantEvent(event, lastSignificantHistoryAt.current)) return '';
    const id = crypto.randomUUID();
    const rejectedValidation = event.alertValidation?.status === 'rejected'
      && !isIndependentVisualHistoryEvent(event);
    const unconfirmedFire = event.type === 'fire' && event.fireConfirmed !== true;
    const unconfirmedSmoke = event.type === 'smoke' && event.smokeConfirmed !== true;
    // A verified VISUAL incident does not need a matching audio keyword to
    // preserve its historical evidence. This never changes Camera Alerts.
    const storedEvent = rejectedValidation || unconfirmedFire || unconfirmedSmoke
      ? { ...event, snapshot: undefined, priorityScenario: false }
      : event;
    addEvent({ ...storedEvent, id });
    const video = getCameraSession(storedEvent.cameraId).video;
    // Record only after both audio and matching camera evidence pass the same
    // fusion gate used by Camera alerts and notifications.
    if (
      !video
      || !isPriorityCameraAlert(storedEvent)
      || recordingCameras.current.has(storedEvent.cameraId)
    ) return id;
    recordingCameras.current.add(storedEvent.cameraId);
    void recordClip(video).then(async blob => {
      if (!blob) {
        updateEvent(id, { clipError: 'Could not record a clip from this camera.' });
        return;
      }
      const name = clipFileName(storedEvent.cameraName, storedEvent.type);
      await saveClip(blob, name);
      updateEvent(id, { clipFile: name, clipUrl: URL.createObjectURL(blob), clipError: undefined });
    }).catch(error => {
      const message = error instanceof Error ? error.message : 'Could not save the clip.';
      updateEvent(id, { clipError: message });
      toast.error(message, { id: `camera-clip-save:${storedEvent.cameraId}` });
    }).finally(() => recordingCameras.current.delete(storedEvent.cameraId));
    return id;
  }, [addEvent, updateEvent]);

  const raiseAlert = useCallback((event: Omit<DetectionEvent, 'id'>, severity: Alert['severity'], alreadyStored = false) => {
    const key = `${event.cameraId}:${event.label}`;
    const now = Date.now();
    // Multimodal distress is already de-duplicated by consuming its exact
    // face+speech evidence pair. Do not suppress a separately valid consecutive
    // trigger just because it has the same human-readable label.
    const edgeDeduped = event.type === 'multimodal-distress'
      || event.type === 'fire'
      || event.type === 'motion-anomaly'
      || event.type === 'attention-alert';
    const cooldownMs = edgeDeduped ? 0 : (settings.alertCooldownMs ?? 3000);
    if (cooldownMs > 0 && now - (alertCooldown.current.get(key) || 0) < cooldownMs) return;
    if (cooldownMs > 0) alertCooldown.current.set(key, now);
    const priority = classifyPriorityScenario(event, severity);
    const storedEvent = { ...event, priorityScenario: priority.priority };
    const id = alreadyStored ? crypto.randomUUID() : storeEvent(storedEvent);

    // Significant visual-only events enter Event History, but they do not
    // enter Camera alerts, announcements, email, or the emergency popup.
    if (!priority.priority) return;

    if (severity === 'high' || severity === 'critical') {
      announce(`Alert. ${event.cameraName}. ${event.label}`, true);
      void logAlert(event.type, `${event.cameraName}: ${event.label}`);
      if (householdId) void sendAlertEmail({
        householdId, alertId: id, alertType: event.type, message: `${event.cameraName}: ${event.label}`,
        severity, cameraLabel: event.cameraName, occurredAt: event.timestamp, confidence: event.confidence,
        trigger: event.label, details: { Location: event.location || undefined, PriorityScenario: priority.reason || undefined },
        snapshotDataUrl: event.snapshot,
      }).then(result => {
        if (result.reason === 'error') {
          toast.error('Alert email could not be sent. Open Household → Notifications and send a test email to check the setup.', { id: 'camera-alert-email' });
        } else if (result.reason === 'no_recipients') {
          toast.error('Add an email recipient in Household → Notifications to receive alerts.', { id: 'camera-alert-email' });
        }
      });
    }
    if (priority.emergency) setShowEmergency(true);
  }, [storeEvent, logAlert, householdId, settings.alertCooldownMs]);

  const handleEvent = useCallback((event: Omit<DetectionEvent, 'id'>) => {
    // Routine objects, faces and saliency remain live diagnostics only.
    // Emotion events must never enter the alarm, announcement, email, or emergency path.
    if (event.type === 'object' || event.type === 'human' || event.type === 'emotion' || event.type === 'saliency') {
      storeEvent(event);
      return;
    }

    // Only accepted audio + matching camera fusion becomes a Camera alert.
    // Only materially significant visual incidents enter history.
    const severity: Alert['severity'] = event.type === 'attention-alert'
      ? 'medium'
      : event.type === 'fire' || event.type === 'smoke' || event.type === 'multimodal-distress'
        ? 'critical'
        : event.type === 'motion-anomaly' && /person collapse/i.test(event.label)
          ? 'critical'
          : 'high';
    raiseAlert(event, severity);

    // A verified face+voice/fire+voice event also passes through the household
    // wake-word database. This records the configured Supabase wake word only
    // after multimodal verification; an unaccepted KWS candidate never reaches
    // this database/notification path.
    if (isPriorityCameraAlert(event)) {
      const match = checkForWakeWord(event.label);
      if (match.matched) {
        void logNotification(match.wakeWordId, match.phrase, match.actionType, match.isEmergency);
      }
    }
  }, [storeEvent, raiseAlert, checkForWakeWord, logNotification]);

  const handleMetrics = useCallback((index: number, runtime: CameraRuntime) => {
    setRuntimes(previous => previous[index] === runtime ? previous : { ...previous, [index]: runtime });

    // In custom mode only an ACCEPTED KWS result is allowed into the household
    // wake-word database. last_candidate is diagnostic and may be rejected.
    const customMode = runtime.audio?.recognition_engine === 'custom';
    const kws = runtime.audio?.custom_kws;
    const acceptedCustomKeyword = customMode && kws?.last_decision === 'accepted'
      ? (kws.last_keyword || '').trim()
      : '';
    const recognizedSpeech = customMode ? acceptedCustomKeyword : runtime.transcript.trim();
    if (!recognizedSpeech) return;

    // Always check accepted speech against the household Supabase wake_words
    // table first. Configured words are reserved for their matching facial
    // expression, while "fire" requires a confirmed large live fire region.
    const match = checkForWakeWord(recognizedSpeech);
    if (
      makeDistressSpeechSignal(recognizedSpeech)
      || makeFireSpeechSignal(recognizedSpeech)
    ) return;

    if (!match.matched) return;
    const previous = householdMatches.current.get(index);
    const now = Date.now();
    if (previous?.phrase === match.phrase && now - previous.at < 15000) return;
    householdMatches.current.set(index, { phrase: match.phrase, at: now });
    const slot = slots[index - 1];
    storeEvent({
      cameraId: `slot-${index}`,
      cameraName: slot.name,
      location: slot.ip,
      type: 'audio-distress',
      label: `Wake word: "${match.phrase}"`,
      confidence: 1,
      priorityScenario: false,
      timestamp: new Date(now).toISOString(),
    });
    void logNotification(match.wakeWordId, match.phrase, match.actionType, match.isEmergency);
  }, [checkForWakeWord, slots, storeEvent, logNotification]);

  // A local webcam uses the existing local microphone. CCTV speech comes only from its bridge.
  useEffect(() => {
    if (!running || !localCameras.length || connected.length) return;
    const result = speech.finalResult;
    if (!result) {
      lastLocalSpeechTrigger.current = null;
      return;
    }
    // Each final speech segment is consumed once. Reserved safety cues use
    // the camera pipeline's shared fusion path, including pending validation.
    if (lastLocalSpeechTrigger.current === result.id) return;
    lastLocalSpeechTrigger.current = result.id;
    const text = result.transcript;
    if (makeFireSpeechSignal(text) || makeDistressSpeechSignal(text)) return;

    const household = checkForWakeWord(text);
    const safety = matchWakeWord(text);
    if (!household.matched && !safety.matched) return;
    const phrase = household.matched ? household.phrase : safety.phrase;
    const slot = slots[0];
    storeEvent({
      cameraId: 'slot-1',
      cameraName: slot.name,
      location: '',
      type: 'audio-distress',
      label: `Wake word: "${phrase}"`,
      confidence: result.confidence,
      priorityScenario: false,
      timestamp: result.timestamp,
    });
  }, [running, localCameras.length, connected.length, speech.finalResult, checkForWakeWord, slots, storeEvent]);

  useEffect(() => {
    if (!running || !localCameras.length || connected.length) return;

    if (audioFeatures.audioEvent === 'scream') {
      // Screaming is diagnostic only. Distress alerts require a configured
      // accepted keyword plus its matching facial expression.
      return;
    }

    if (audioFeatures.audioEvent === 'bang') {
      raiseAlert({ cameraId: 'slot-1', cameraName: slots[0].name, location: '', type: 'audio-distress',
        label: 'Impact detected', confidence: 0, timestamp: new Date().toISOString(),
      }, 'critical');
    }
  }, [running, localCameras.length, connected.length, audioFeatures.audioEvent, slots, raiseAlert, runtimes]);

  useEffect(() => {
    if (!localAudioEnabled) return;
    // A smoke/fire alarm is a strong semantic cue. Generic Fire/Crackle is
    // noisier in a household, so require substantially stronger evidence.
    const threshold = yamnet.fireAlarm ? 35 : 60;
    if (yamnet.fireScore < threshold) return;
    storeEvent({
      cameraId: 'slot-1',
      cameraName: slots[0].name,
      location: 'Local microphone',
      type: 'fire',
      label: `Fire-related sound: ${yamnet.fireLabel} (${yamnet.fireScore}%)`,
      confidence: yamnet.fireScore / 100,
      priorityScenario: false,
      alertValidation: {
        status: 'rejected',
        reason: 'Fire-related audio was detected, but visual fire validation was not satisfied.',
        keyword: '',
        emotion: 'audio fire cue',
      },
      timestamp: new Date().toISOString(),
      snapshot: captureCameraEventSnapshot('slot-1'),
    });
  }, [localAudioEnabled, yamnet.fireAlarm, yamnet.fireScore, yamnet.fireLabel, slots, storeEvent]);

  useEffect(() => {
    if (!localAudioEnabled || yamnet.distressScore < 35) return;

    if (yamnet.topLabel === 'Screaming') {
      // Screaming alone, even with a facial cue, never satisfies the strict
      // distress alert rule. An accepted keyword and matching expression are required.
      return;
    }

    raiseAlert({ cameraId: 'slot-1', cameraName: slots[0].name, location: 'Local microphone', type: 'audio-distress',
      label: `Audio distress: ${yamnet.topLabel} (${yamnet.distressScore}%)`, confidence: yamnet.topScore,
      timestamp: new Date().toISOString(),
    }, yamnet.distressScore >= 60 ? 'critical' : 'high');
  }, [localAudioEnabled, yamnet.distressScore, yamnet.topLabel, yamnet.topScore, slots, raiseAlert, runtimes]);

  const handleStart = useCallback(async () => {
    setCameraError('');
    if (slots.some(slot => slot.connected)) { setRunning(true); return; }
    const started = await startCameras(quality).catch(() => []);
    if (!started.some(camera => camera.active)) {
      setCameraError('Connect a CCTV camera or an available webcam to start monitoring.');
      openConnection(1);
      return;
    }
    void startAudio().catch(() => {});
    if (speechSupported) startSpeech();
    setRunning(true);
  }, [slots, startCameras, quality, startAudio, speechSupported, startSpeech, setRunning, openConnection]);

  const handleStop = useCallback(() => {
    setRunning(false);
    stopCameras(); stopAudio(); stopSpeech(); clearSpeech();
    const server = serverUrlFor(loadServerHost());
    for (const slot of slots) if (slot.connected || slot.autoConnect) {
      updateSlot(slot.index, { autoConnect: false, connected: false, streamUrl: '', webrtcUrl: '' });
      void stopCamera(server, `slot-${slot.index}`).catch(() => {});
    }
    void stopAllCameras(server).catch(() => {});
  }, [setRunning, stopCameras, stopAudio, stopSpeech, clearSpeech, slots, updateSlot]);

  const exportCSV = () => {
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [['Timestamp', 'Camera', 'Detection', 'Confidence'], ...events.filter(isSignificantHistoryEvent).map(event => [event.timestamp, event.cameraName, event.label, String(event.confidence)])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = `camera-events-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const tutorialSteps: TutorialStep[] = [
    { selector: '#tour-header', title: 'Monitoring dashboard', placement: 'bottom', body: 'Connect your cameras and review their latest snapshots here.' },
    { selector: '#tour-cams', title: 'Last-seen images', placement: 'bottom', body: 'Each card holds the last image captured from its camera. Open a connected camera for realtime video; offline cards open connection settings.' },
    { selector: '#tour-live-transcription', title: 'Camera audio', placement: 'bottom', body: 'The trained CCTV safety-keyword detector continues while the dashboard displays snapshots. Muting live playback does not stop listening.' },
    { selector: '#tour-start', title: 'Monitoring controls', placement: 'left', body: 'Use Start and Stop to control monitoring. Live video plays only on the Cameras page.' },
  ];
  useEffect(() => {
    if (authLoading || liveView) return;
    const key = user ? `msds-tutorial-done-${user.id}` : 'msds-tutorial-done-guest';
    if (localStorage.getItem(key)) return;
    const timeout = window.setTimeout(() => setShowTutorial(true), 600);
    return () => window.clearTimeout(timeout);
  }, [authLoading, liveView, user]);

  const openAlgorithmTutorial = (algorithm: AlgorithmId) => {
    setShowExpert(false); setTutorialOverride(ALGORITHM_TOURS[algorithm]); setShowTutorial(true);
  };

  return (
    <>
      {slots.map(slot => <CameraMonitor key={slot.index} slot={slot} monitoring={running} baseSettings={pipelineSettings}
        localStream={slot.connected ? undefined : cameras[slot.index - 1]?.stream || undefined}
        localSpeech={slot.index === 1 && localAudioEnabled ? speech.finalResult : null}
        playbackEnabled={liveView && (!focusedLiveCamera || focusedLiveCamera === `slot-${slot.index}`)}
        onEvent={handleEvent} onMetrics={handleMetrics} />)}
      {liveView && <Monitoring />}
      {!liveView && <div className="min-h-screen bg-background text-foreground">
        <header id="tour-header" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/60 px-4 py-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-2"><Shield className="h-6 w-6 text-primary" /><h1 className="text-lg font-bold">MSDSystem</h1></button>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1.5 text-sm ${running ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{running ? 'Monitoring' : 'Standby'}</span>
            <button onClick={() => navigate('/household')} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm text-primary"><Home className="h-4 w-4" /><span className="hidden sm:inline">Home</span></button>
            <button onClick={() => navigate('/cameras')} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm text-primary"><Wifi className="h-4 w-4" /><span>Cameras</span></button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowExpert(true)} title="Expert Mode" className="flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-sm text-accent"><Sparkles className="h-4 w-4" /><span className="hidden sm:inline">Expert</span></button>
            <button onClick={() => setDarkMode(value => !value)} title={darkMode ? 'Light mode' : 'Dark mode'} className="rounded-lg p-2 hover:bg-muted">{darkMode ? <Sun className="h-5 w-5 text-warning" /> : <Moon className="h-5 w-5" />}</button>
            <AccessibilityPanel />
            <button onClick={() => { setTutorialOverride(null); setShowTutorial(true); }} title="Replay tutorial" className="rounded-lg p-2 hover:bg-muted"><HelpCircle className="h-5 w-5" /></button>
            <span className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline">{user?.email}</span>
            <button onClick={signOut} title="Sign Out" className="rounded-lg p-2 hover:bg-muted"><LogOut className="h-5 w-5" /></button>
            <button onClick={() => setSidebarOpen(true)} aria-label="Open controls" className="rounded-lg p-2 hover:bg-muted lg:hidden"><Menu className="h-5 w-5" /></button>
          </div>
        </header>

        <main className="flex min-h-[calc(100vh-65px)] flex-col lg:h-[calc(100vh-65px)] lg:flex-row">
          <div className="min-w-0 flex-1 space-y-4 p-3 lg:overflow-y-auto">
            <div className="flex flex-wrap items-end justify-between gap-3 py-2">
              <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
              <button onClick={() => openConnection(1)} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Manage cameras</button>
            </div>
            <div id="tour-cams"><div id="tour-fused-view" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {slots.map(slot => <DashboardCameraCard key={slot.index} slot={slot} monitoring={running} mirror={mirror}
                transcript={slot.index === 1 && localAudioEnabled ? `${speech.transcript} ${speech.interimTranscript}`.trim() : undefined}
                eventCount={eventCounts.get(`slot-${slot.index}`) || 0} onConnect={openConnection}
                onToggleAi={index => updateSlot(index, { aiEnabled: !slots[index - 1].aiEnabled })} />)}
            </div></div>

            <section id="tour-saliency-score" className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-semibold">Detection summary
                  <select aria-label="Choose detection summary camera" value={selectedCamera} onChange={event => setSelectedCamera(Number(event.target.value))} className="rounded-lg border border-border bg-background px-2 py-1">
                    {slots.map(slot => <option key={slot.index} value={slot.index}>{slot.name}</option>)}
                  </select>
                </label>
                <span className={`text-xl font-bold tabular-nums ${saliency > 70 ? 'text-destructive' : 'text-primary'}`}>Saliency {saliency}%</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div id="tour-fire-analysis" className={`rounded-lg border p-3 ${currentRuntime?.fire.detected || currentRuntime?.smoke.detected ? 'border-destructive/50 bg-destructive/5' : 'border-border'}`}>
                  <h3 className="flex items-center gap-2 text-sm"><Flame className="h-4 w-4" />Fire &amp; smoke</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{currentRuntime?.fire.detected ? 'Fire detected' : currentRuntime?.smoke.detected ? 'Smoke detected' : 'No fire or smoke detected'}</p>
                  {currentRuntime?.fire.detected && <DetectionFeedback householdId={householdId} eventType="fire" confidence={currentRuntime.fire.confidence} />}
                </div>
                <div id="tour-audio-distress" className="rounded-lg border border-border p-3">
                  <h3 className="flex items-center gap-2 text-sm"><Mic className="h-4 w-4" />Audio &amp; safety phrases</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{selectedCamera === 1 && localAudioEnabled ? (yamnet.error || `${yamnet.topLabel} (${yamnet.distressScore}% distress)`) : currentRuntime?.audioDistress.detected ? currentRuntime.audioDistress.keyword || 'Safety phrase detected' : currentRuntime?.audioMessage || 'Connect a camera to start listening.'}</p>
                </div>
                <div id="tour-face-distress" className="rounded-lg border border-border p-3">
                  <h3 className="text-sm">Facial distress</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{currentRuntime?.faceDistress.detected ? `${currentRuntime.faceDistress.label} (${Math.round(currentRuntime.faceDistress.confidence * 100)}%)` : 'No facial distress detected'}</p>
                </div>
              </div>
            </section>
            {cameraError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{cameraError}</p>}
          </div>

          {sidebarOpen && <button aria-label="Close controls overlay" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-40 bg-black/40 lg:hidden" />}
          <aside id="tour-sidebar" className={`${sidebarOpen ? 'block' : 'hidden lg:block'} fixed right-0 top-0 z-50 h-full w-80 max-w-[90vw] space-y-3 overflow-y-auto border-l border-border bg-card p-3 lg:static lg:z-auto lg:h-auto lg:shrink-0 lg:bg-transparent`}>
            <button onClick={() => setSidebarOpen(false)} aria-label="Close controls" className="ml-auto block rounded-lg p-2 lg:hidden"><X className="h-4 w-4" /></button>
            <div id="tour-start" className="rounded-xl border border-border bg-card p-3">
              <button onClick={running ? handleStop : handleStart} className={`w-full rounded-lg px-3 py-2.5 text-sm ${running ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'}`}>{running ? 'Stop Monitoring' : 'Start Monitoring'}</button>
            </div>
            <AttentionGauge score={attention} />
            <ControlsPanel snapshotMode running={running} threshold={settings.saliencyThreshold ?? 40} showBoundingBoxes={showBoundingBoxes} showHeatmap={showHeatmap}
              quality={quality} mirror={mirror} heatmapOpacity={heatmapOpacity} simulationMode={simulationMode} priorityObjects={priorityObjects} minConfidence={Math.round(settings.objectThreshold * 100)}
              saliencyMode={settings.saliencyMode ?? 'sobel'} attentionThreshold={settings.attentionThreshold ?? 15} alertCooldownMs={settings.alertCooldownMs ?? 3000}
              onStart={handleStart} onStop={handleStop} onThresholdChange={value => updateSettings({ saliencyThreshold: value })}
              onSaliencyModeChange={value => updateSettings({ saliencyMode: value })} onAttentionThresholdChange={value => updateSettings({ attentionThreshold: value })}
              onAlertCooldownChange={value => updateSettings({ alertCooldownMs: value })}
              onToggleBoundingBoxes={() => setShowBoundingBoxes(value => !value)}
              onToggleHeatmap={() => setShowHeatmap(value => !value)} onQualityChange={setQuality}
              onToggleMirror={() => setMirror(value => !value)} onHeatmapOpacityChange={setHeatmapOpacity} onToggleSimulation={() => setSimulationMode(value => !value)}
              onPriorityObjectsChange={setPriorityObjects} onMinConfidenceChange={value => updateSettings({ objectThreshold: value / 100 })} onExportCSV={exportCSV} />
          </aside>
        </main>
      </div>}

      {!liveView && showIpDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={closeConnection}>
        <div role="dialog" aria-modal="true" aria-labelledby="camera-connect-title" className="max-h-[92vh] w-full max-w-5xl space-y-5 overflow-y-auto rounded-xl border border-border bg-card p-6" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3"><h3 id="camera-connect-title" className="flex items-center gap-2 text-xl"><Wifi className="h-5 w-5 text-primary" />Connect CCTV / IP Camera</h3><button onClick={closeConnection} aria-label="Close camera connection panel" className="rounded-lg p-2 hover:bg-muted"><X className="h-5 w-5" /></button></div>
          <MultiCameraConnect selectedSlot={selectedCamera} />
          {devices.length > 0 && <p className="text-sm text-muted-foreground">{devices.length} local webcam{devices.length === 1 ? '' : 's'} available through Start Monitoring.</p>}
          <button onClick={closeConnection} className="w-full rounded-lg border border-border px-4 py-2 hover:bg-muted">Close</button>
        </div>
      </div>}

      {showEmergency && <div className="fixed bottom-4 right-4 z-[60] w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-destructive bg-destructive p-4 text-destructive-foreground shadow-xl">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm">EMERGENCY DETECTED</h3><button onClick={() => setShowEmergency(false)} aria-label="Close emergency alert"><X className="h-5 w-5" /></button></div>
        <p className="text-sm">A camera safety trigger needs your attention.</p>
        <a href="tel:911" className="block rounded-lg bg-background px-4 py-2.5 text-center text-sm font-bold text-destructive">CALL 911</a>
        <button onClick={() => setShowEmergency(false)} className="w-full text-sm">Dismiss (false alarm)</button>
      </div>}
      <TutorialOverlay steps={tutorialOverride || tutorialSteps} open={!liveView && showTutorial} onClose={() => { setShowTutorial(false); setTutorialOverride(null); }} onFinish={() => localStorage.setItem(user ? `msds-tutorial-done-${user.id}` : 'msds-tutorial-done-guest', '1')} />
      <ExpertMode open={!liveView && showExpert} onClose={() => setShowExpert(false)} onSelectAlgorithm={openAlgorithmTutorial} />
    </>
  );
}
