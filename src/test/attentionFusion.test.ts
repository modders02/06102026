import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTENTION_THRESHOLD,
  FUSION_WEIGHTS,
  audioEventScore,
  audioIntensityScoreFromDb,
  audioIntensityScoreFromRms,
  computeAttentionScore,
  objectRelevanceScore,
} from '@/lib/attentionFusion';

describe('SOP attention fusion', () => {
  it('uses the thesis 0.4 visual / 0.3 audio / 0.3 object weights', () => {
    expect(FUSION_WEIGHTS).toEqual({ visual: 0.4, audio: 0.3, object: 0.3 });
    expect(DEFAULT_ATTENTION_THRESHOLD).toBe(15);
    expect(computeAttentionScore(50, 20, 80)).toBe(50);
  });

  it('sums only configured priority-object confidence', () => {
    const objects = [
      { label: 'person', confidence: 0.6, bbox: [0, 0, 10, 10] as [number, number, number, number] },
      { label: 'chair', confidence: 0.5, bbox: [10, 0, 10, 10] as [number, number, number, number] },
      { label: 'cat', confidence: 0.99, bbox: [20, 0, 10, 10] as [number, number, number, number] },
    ];
    expect(objectRelevanceScore(objects, ['person', 'chair'])).toBe(100);
    expect(objectRelevanceScore(objects, ['chair'])).toBe(50);
    expect(objectRelevanceScore(objects, [])).toBe(0);
  });

  it('normalizes real microphone intensity and preserves event floors', () => {
    expect(audioIntensityScoreFromDb(-60)).toBe(0);
    expect(audioIntensityScoreFromDb(-30)).toBe(50);
    expect(audioIntensityScoreFromDb(0)).toBe(100);
    expect(audioIntensityScoreFromRms(0)).toBe(0);
    expect(audioIntensityScoreFromRms(1)).toBe(100);
    expect(audioEventScore('speech', 3)).toBe(10);
    expect(audioEventScore('bang', 8)).toBe(20);
    expect(audioEventScore('scream', 65)).toBe(65);
  });

  it('clips every modality to a valid 0..100 contribution', () => {
    expect(computeAttentionScore(500, -20, 500)).toBe(70);
  });
});
