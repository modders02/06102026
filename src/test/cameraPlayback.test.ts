import { describe, expect, it } from 'vitest';
import { createPlaybackFrameCounter } from '@/lib/cameraPlayback';

function fakeVideo() {
  let decoded = 0;
  let now = 0;
  const video = { currentTime: 0, paused: false, getVideoPlaybackQuality: () => ({ totalVideoFrames: decoded }) } as HTMLVideoElement;
  const counter = createPlaybackFrameCounter(video, () => now);
  return { video, counter, tick(frames: number, elapsed = 1000) { decoded += frames; now += elapsed; return counter.sample(); } };
}

describe('camera playback frame measurement', () => {
  it('measures decoded frames when compositor callbacks are throttled in an installed app', () => {
    const { counter, tick } = fakeVideo();
    // An available requestVideoFrameCallback API does not imply callbacks run.
    expect(tick(30)).toEqual({ fps: 30, advanced: true });
    expect(tick(45, 1500)).toEqual({ fps: 30, advanced: true });
    expect(tick(0)).toEqual({ fps: 0, advanced: false });
    counter.reset();
    expect(tick(25)).toEqual({ fps: 25, advanced: true });
  });

  it('counts the presented frames between callbacks when the renderer misses callbacks', () => {
    const { counter, tick } = fakeVideo();
    counter.countPresentedFrame({ presentedFrames: 100 } as VideoFrameCallbackMetadata);
    expect(tick(0).fps).toBe(1);
    counter.countPresentedFrame({ presentedFrames: 130 } as VideoFrameCallbackMetadata);
    expect(tick(0)).toEqual({ fps: 30, advanced: true });
  });

  it('does not add decoder and compositor counts for the same frames', () => {
    const { counter, tick } = fakeVideo();
    counter.countPresentedFrame({ presentedFrames: 1 } as VideoFrameCallbackMetadata);
    expect(tick(30).fps).toBe(30);
  });

  it('uses the legacy decoder counter in WebViews without playback quality', () => {
    let now = 0;
    const video = { currentTime: 0, paused: false, webkitDecodedFrameCount: 10 };
    const counter = createPlaybackFrameCounter(video as unknown as HTMLVideoElement, () => now);
    video.webkitDecodedFrameCount = 35;
    now = 1000;
    expect(counter.sample()).toEqual({ fps: 25, advanced: true });
  });

  it('excludes dropped frames from measured playback FPS', () => {
    let now = 0;
    const quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
    const video = { currentTime: 0, paused: false, getVideoPlaybackQuality: () => quality } as HTMLVideoElement;
    const counter = createPlaybackFrameCounter(video, () => now);
    quality.totalVideoFrames = 30;
    quality.droppedVideoFrames = 5;
    now = 1000;
    expect(counter.sample()).toEqual({ fps: 25, advanced: true });
  });

  it('recognizes a healthy offscreen stream even when every decoded frame is dropped', () => {
    let now = 0;
    const quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
    const video = { currentTime: 0, paused: false, getVideoPlaybackQuality: () => quality } as HTMLVideoElement;
    const counter = createPlaybackFrameCounter(video, () => now);
    quality.totalVideoFrames = quality.droppedVideoFrames = 30;
    now = 1000;
    expect(counter.sample()).toEqual({ fps: 0, advanced: true });
    now = 2000;
    expect(counter.sample()).toEqual({ fps: 0, advanced: false });
  });

  it('detects progress without guessing FPS when a browser exposes no frame counters', () => {
    let now = 0;
    const video = { currentTime: 0, paused: false } as HTMLVideoElement;
    const counter = createPlaybackFrameCounter(video, () => now);
    now = 1000;
    video.currentTime = 1;
    expect(counter.sample()).toEqual({ fps: 0, advanced: true });
    now = 2000;
    expect(counter.sample()).toEqual({ fps: 0, advanced: false });
  });
});
