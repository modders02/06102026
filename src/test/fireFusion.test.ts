import { describe, expect, it } from 'vitest';
import {
  FIRE_FUSION_WINDOW_MS,
  FIRE_LOW_VISIBILITY,
  SMOKE_REGION_MIN_RATIO,
  fireSmokeLabel,
  fireSpeechLabel,
  fuseFireWithSunog,
  isImmediateFireSmoke,
  makeFireVisualSignal,
  makeSunogSignal,
} from '@/lib/fireFusion';

describe('fire verification fusion', () => {
  it.each(['sunog', 'may sunog', 'amoy sunog', 'nasusunog', 'sonog'])(
    'recognizes %s as a reserved fire keyword',
    phrase => {
      expect(makeSunogSignal(phrase, 0.96, 1000)).toEqual({
        phrase: 'sunog',
        confidence: 0.96,
        at: 1000,
      });
    },
  );

  it('does not reserve smoke-only or unrelated fire vocabulary as sunog', () => {
    expect(makeSunogSignal('may usok', 1, 1000)).toBeNull();
    expect(makeSunogSignal('call the fire department', 1, 1000)).toBeNull();
  });

  it('accepts a small visual candidate for corroboration', () => {
    expect(makeFireVisualSignal(true, 0.2, 0.001, 0.01, 90, 2000)).toEqual({
      confidence: 0.37,
      at: 2000,
      firePixelRatio: 0.001,
      smokeRatio: 0.01,
      visibility: 90,
      smokeCorroborated: false,
      lowVisibilityCorroborated: false,
    });
  });

  it('requires visual fire plus sunog within the fusion window', () => {
    const fire = makeFireVisualSignal(true, 0.6, 0.01, 0, 90, 5000)!;
    const speech = makeSunogSignal('sunog', 0.98, 5000 + FIRE_FUSION_WINDOW_MS)!;
    expect(fuseFireWithSunog(fire, speech)).toMatchObject({
      confidence: 0.6,
      at: 5000 + FIRE_FUSION_WINDOW_MS,
    });
    expect(fireSpeechLabel()).toBe('Verified fire: visual fire + "sunog"');
    expect(fuseFireWithSunog(null, speech)).toBeNull();
  });

  it('rejects sunog outside the fusion window', () => {
    const fire = makeFireVisualSignal(true, 0.6, 0.01, 0, 90, 5000)!;
    const speech = makeSunogSignal('sunog', 0.98, 5000 + FIRE_FUSION_WINDOW_MS + 1)!;
    expect(fuseFireWithSunog(fire, speech)).toBeNull();
  });

  it('immediately verifies fire plus a meaningful smoke region', () => {
    const fire = makeFireVisualSignal(true, 0.4, 0.002, SMOKE_REGION_MIN_RATIO, 70, 1000, true, false)!;
    expect(isImmediateFireSmoke(fire)).toBe(true);
    expect(fireSmokeLabel(fire)).toBe('Verified fire: fire + smoke region (18%)');
  });

  it('immediately verifies fire plus low visibility', () => {
    const fire = makeFireVisualSignal(true, 0.4, 0.002, 0.05, FIRE_LOW_VISIBILITY, 1000, false, true)!;
    expect(isImmediateFireSmoke(fire)).toBe(true);
    expect(fireSmokeLabel(fire)).toBe('Verified fire: fire + low visibility (45/100)');
  });

  it('does not treat a naturally gray scene as smoke corroboration without temporal change', () => {
    const fire = makeFireVisualSignal(true, 0.44, 0.01, 0.60, 70, 1000, false, false)!;
    expect(isImmediateFireSmoke(fire)).toBe(false);
  });

  it('does not verify smoke or low visibility without a fire candidate', () => {
    expect(makeFireVisualSignal(false, 0.8, 0, 0.5, 20, 1000)).toBeNull();
    expect(isImmediateFireSmoke(null)).toBe(false);
  });
});
