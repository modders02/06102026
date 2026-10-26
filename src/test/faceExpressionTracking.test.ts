import { describe, expect, it } from 'vitest';
import {
  emptyFaceTrackingState,
  updateFaceExpressionTracks,
  FACE_EXPRESSION_STABLE_FRAMES,
} from '@/lib/faceExpressionTracking';
import type { FaceExpressionSample, FaceTrackingState } from '@/lib/faceExpressionTracking';

const face = (x: number, expression: string, confidence = 0.94): FaceExpressionSample => ({
  bounds: { x, y: 0.2, width: 0.18, height: 0.32 },
  expression, confidence,
});

function advance(state: FaceTrackingState, faces: FaceExpressionSample[], now: number) {
  return updateFaceExpressionTracks(state, faces, now);
}

describe('independent CCTV facial expression stability', () => {
  it('does not record a one-frame or two-frame false expression', () => {
    let state = emptyFaceTrackingState();
    for (let frameIndex = 0; frameIndex < FACE_EXPRESSION_STABLE_FRAMES - 1; frameIndex++) {
      const current = advance(state, [face(0.1, 'angry')], frameIndex * 600);
      state = current.state;
      expect(current.events).toEqual([]);
    }
    const stable = advance(state, [face(0.11, 'angry')], 1200);
    expect(stable.events).toMatchObject([{ trackId: 1, label: 'Angry', confidence: 0.94 }]);
    const held = advance(stable.state, [face(0.12, 'angry')], 1800);
    expect(held.events).toEqual([]);
  });

  it('logs two simultaneous happy faces separately but never every frame', () => {
    let state = emptyFaceTrackingState();
    let results: ReturnType<typeof advance>['events'] = [];
    for (let step = 0; step < 8; step++) {
      const current = advance(state, [face(0.10, 'happy'), face(0.66, 'happy')], step * 750);
      state = current.state;
      results.push(...current.events);
    }
    expect(results).toMatchObject([
      { trackId: 1, label: 'Happy' },
      { trackId: 2, label: 'Happy' },
    ]);
    expect(results).toHaveLength(2);
  });

  it('ignores brief neutral noise and confirms only sustained expression changes', () => {
    let state = emptyFaceTrackingState();
    for (let i = 0; i < 3; i++) state = advance(state, [face(0.2, 'happy')], i * 750).state;
    let result = advance(state, [face(0.2, 'sad')], 2400);
    expect(result.events).toEqual([]);
    result = advance(result.state, [face(0.2, 'happy')], 3150);
    expect(result.events).toEqual([]);
    for (const time of [3900, 4650, 5400]) result = advance(result.state, [face(0.2, 'sad')], time);
    expect(result.events).toMatchObject([{ trackId: 1, label: 'Sad' }]);
  });

  it('requires a stronger stable neutral score and ignores unsupported classes', () => {
    let state = emptyFaceTrackingState();
    for (const now of [0, 600, 1200]) {
      const result = advance(state, [face(0.2, 'neutral', 0.72)], now);
      state = result.state;
      expect(result.events).toEqual([]);
    }
    for (const now of [1800, 2400, 3000]) {
      const result = advance(state, [face(0.2, 'neutral', 0.91)], now);
      state = result.state;
      if (now < 3000) expect(result.events).toEqual([]);
      else expect(result.events).toMatchObject([{ label: 'Neutral' }]);
    }
    expect(advance(state, [face(0.2, 'unknown')], 3600).events).toEqual([]);
  });

  it('expires old spatial tracks and never treats face location as an identity', () => {
    let state = emptyFaceTrackingState();
    for (const now of [0, 600, 1200]) state = advance(state, [face(0.1, 'happy')], now).state;
    state = advance(state, [], 8200).state;
    const current = advance(state, [face(0.1, 'happy')], 8800);
    expect(current.events).toEqual([]);
    expect(current.state.tracks[0].id).toBe(2);
  });

  it('does not match opposite sides of the image as one person', () => {
    let state = emptyFaceTrackingState();
    state = advance(state, [face(0.15, 'happy')], 0).state;
    const result = advance(state, [face(0.72, 'sad')], 600);
    expect(result.state.tracks.map(track => track.id).sort()).toEqual([1, 2]);
  });
});
