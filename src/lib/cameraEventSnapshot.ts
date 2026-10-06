import { getCameraSession } from '@/lib/cameraSessions';

/** Capture a ready source frame without changing playback or the analysis canvas. */
export function captureVideoSnapshot(video: HTMLVideoElement | null): string | undefined {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return undefined;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(640, video.videoWidth);
    canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.65);
  } catch {
    return undefined;
  }
}

/** Fallbacks always belong to the same camera as the event. */
export function captureCameraEventSnapshot(cameraId: string): string | undefined {
  const session = getCameraSession(cameraId);
  return captureVideoSnapshot(session.video) || session.eventPreview || session.preview || undefined;
}
