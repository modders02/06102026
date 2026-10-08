import { describe, expect, it } from 'vitest';
import { validateSafetyEvent } from '@/lib/safetyValidation';

const base = {
  cameraId: 'slot-1',
  cameraName: 'Camera 1',
  location: 'Indoor test room',
  timestamp: new Date().toISOString(),
};

describe('safety validation layer', () => {
  it('accepts a corroborated multimodal distress event', () => {
    expect(validateSafetyEvent({
      ...base,
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
      confidence: 0.91,
    }).valid).toBe(true);
  });

  it('rejects a distress event without multimodal corroboration', () => {
    const result = validateSafetyEvent({
      ...base,
      type: 'multimodal-distress',
      label: 'Frightened',
      confidence: 0.91,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('distress_missing_multimodal_corroboration');
  });

  it('rejects weak saliency caused by ordinary environmental variation', () => {
    expect(validateSafetyEvent({
      ...base,
      type: 'saliency',
      label: 'Motion change',
      confidence: 0.45,
    }).valid).toBe(false);
  });

  it('keeps ordinary object detections informational', () => {
    expect(validateSafetyEvent({
      ...base,
      type: 'object',
      label: 'chair',
      confidence: 0.4,
    }).valid).toBe(true);
  });
});
