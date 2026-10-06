// Compositor callbacks can be throttled independently of video decoding in an
// installed app. Read the media counters too, including older WebView support.
function videoFrameCounts(video: HTMLVideoElement): { decoded: number; displayed: number } | null {
  const quality = video.getVideoPlaybackQuality?.();
  if (quality && Number.isFinite(quality.totalVideoFrames)) {
    return {
      decoded: quality.totalVideoFrames,
      displayed: Math.max(0, quality.totalVideoFrames - (quality.droppedVideoFrames || 0)),
    };
  }
  const legacy = video as HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number };
  const decoded = legacy.webkitDecodedFrameCount;
  return typeof decoded === 'number' && Number.isFinite(decoded)
    ? { decoded, displayed: Math.max(0, decoded - (legacy.webkitDroppedFrameCount || 0)) } : null;
}

/** Measure the stream itself, independently of AI inference and UI refreshes. */
export function createPlaybackFrameCounter(video: HTMLVideoElement, now = () => performance.now()) {
  let previousAt = now();
  let previousCounts = videoFrameCounts(video);
  let previousTime = video.currentTime;
  let previousPresented: number | null = null;
  let callbackFrames = 0;

  return {
    reset() {
      previousAt = now();
      previousCounts = videoFrameCounts(video);
      previousTime = video.currentTime;
      previousPresented = null;
      callbackFrames = 0;
    },
    countPresentedFrame(metadata: VideoFrameCallbackMetadata) {
      // A busy renderer may miss callbacks; presentedFrames still counts the
      // frames between callbacks. The first callback contributes one frame.
      const total = metadata.presentedFrames;
      callbackFrames += previousPresented === null ? 1 : Math.max(1, total - previousPresented);
      previousPresented = total;
    },
    sample() {
      const sampledAt = now();
      const counts = videoFrameCounts(video);
      const decodedDelta = counts && previousCounts ? Math.max(0, counts.decoded - previousCounts.decoded) : 0;
      const displayedDelta = counts && previousCounts ? Math.max(0, counts.displayed - previousCounts.displayed) : 0;
      const frames = Math.max(displayedDelta, callbackFrames);
      const elapsed = (sampledAt - previousAt) / 1000;
      // An offscreen shared camera can decode fresh frames while dropping every
      // presentation. It is healthy even though its displayed FPS is zero.
      const advanced = decodedDelta > 0 || frames > 0 || (counts === null && previousPresented === null
        && !video.paused && video.currentTime > previousTime);
      previousAt = sampledAt;
      previousCounts = counts;
      previousTime = video.currentTime;
      callbackFrames = 0;
      return { fps: elapsed > 0 ? Math.round(frames / elapsed) : 0, advanced };
    },
  };
}
