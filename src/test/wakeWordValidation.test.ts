import { describe, expect, it } from 'vitest';
import { formatWakeWordDecision } from '@/lib/wakeWordValidation';

describe('wake-word validation wording', () => {
  it.each([
    ['duration_mismatch', 'Speech length does not match the wake word.'],
    ['too_close_to_unknown', 'Speech sounds too similar to other words.'],
    ['verification_pending', 'Checking the wake word.'],
    ['accepted_help_90', 'Wake word confirmed.'],
  ])('explains the backend decision %s', (decision, explanation) => {
    expect(formatWakeWordDecision(decision)).toBe(explanation);
  });

  it.each([
    'duration_mismatch',
    'Keyword rejected by KWS: duration_mismatch.',
    'Keyword candidate rejected: duration_mismatch.',
    'Keyword duration does not match the trained examples.',
    '  DURATION_MISMATCH.  ',
  ])('updates stored duration explanations: %s', reason => {
    expect(formatWakeWordDecision(reason)).toBe('Speech length does not match the wake word.');
  });

  it.each([
    'Keyword rejected by KWS: too_close_to_unknown.',
    'Keyword candidate rejected: too_close_to_unknown.',
    'Candidate is too similar to UNKNOWN/non-keyword speech.',
  ])('updates stored non-keyword explanations: %s', reason => {
    expect(formatWakeWordDecision(reason)).toBe('Speech sounds too similar to other words.');
  });

  it.each([undefined, null, '', '   '])('gives a waiting explanation when no decision is available', reason => {
    expect(formatWakeWordDecision(reason)).toBe('Waiting for a wake word.');
  });

  it.each(['new_backend_reason', 'Keyword candidate rejected: new_backend_reason.'])('keeps an unfamiliar machine code out of the explanation', reason => {
    expect(formatWakeWordDecision(reason)).toBe('The wake word could not be confirmed.');
  });

  it('preserves event-specific explanations', () => {
    const explanation = 'Accepted "fire"; waiting for current visual fire evidence.';
    expect(formatWakeWordDecision(explanation)).toBe(explanation);
  });
});
