const DECISION_MESSAGES = new Map(Object.entries({
  accepted: 'Wake word confirmed.',
  accepted_help_90: 'Wake word confirmed.',
  verified: 'Wake word confirmed.',
  verified_help_rescue: 'Wake word confirmed.',
  negative_not_ready: 'Wake-word validation is still getting ready.',
  duration_mismatch: 'Speech length does not match the wake word.',
  below_threshold: 'The wake word was not clear enough to confirm.',
  too_close_to_unknown: 'Speech sounds too similar to other words.',
  insufficient_margin: 'Speech sounds too similar to another wake word.',
  no_ready_candidate: 'No trained wake word is ready to recognize.',
  verification_pending: 'Checking the wake word.',
  verification_timeout: 'The speech check took too long. The wake word was not confirmed.',
  verification_busy: 'The speech check is busy. This wake word was not confirmed.',
  verification_unavailable: 'The speech check is unavailable. The wake word was not confirmed.',
  verification_no_speech: 'No clear speech was found to confirm the wake word.',
  verification_mismatch: 'The speech check heard different words. The wake word was not confirmed.',
  neural_unavailable: 'Neural keyword verification is unavailable. The wake word was not confirmed.',
  neural_disagreement: 'Neural and trained keyword recognizers disagreed. The wake word was not confirmed.',
  below_frontend_threshold: 'The wake word did not meet the required confidence level.',
}));

// Older history entries may contain an explanation generated before the UI
// shared this wording. Keep their original stored evidence while updating copy.
const LEGACY_DECISIONS = new Map(Object.entries({
  'unknown/non-keyword validation is not ready': 'negative_not_ready',
  'keyword duration does not match the trained examples': 'duration_mismatch',
  'keyword confidence is below the trained acceptance threshold': 'below_threshold',
  'candidate is too similar to unknown/non-keyword speech': 'too_close_to_unknown',
  'candidate is too close to another trained keyword': 'insufficient_margin',
  'no trained keyword candidate is ready': 'no_ready_candidate',
  'whisper speech verification timed out. detection was not accepted; the model may still be loading': 'verification_timeout',
  'whisper is still processing an earlier speech segment. this candidate was not accepted': 'verification_busy',
  'whisper could not run; the keyword remains unverified': 'verification_unavailable',
  'whisper returned no usable speech for this candidate': 'verification_no_speech',
  'whisper recognized a different word; the keyword was rejected': 'verification_mismatch',
}));

/** Formats presentation copy without changing the backend decision or history. */
export function formatWakeWordDecision(reason?: string | null): string {
  const text = reason?.trim();
  if (!text) return 'Waiting for a wake word.';

  const normalized = text.toLowerCase().replace(/[.!]+$/, '');
  const wrappedDecision = normalized.match(/^keyword (?:candidate )?rejected(?: by kws)?:\s*([a-z][a-z0-9_]*)$/)?.[1];
  const decision = wrappedDecision || LEGACY_DECISIONS.get(normalized) || normalized;
  const message = DECISION_MESSAGES.get(decision);
  if (message) return message;

  // A newly introduced backend reason must not leak a machine code into the UI.
  if (wrappedDecision || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(decision)) {
    return 'The wake word could not be confirmed.';
  }

  return text;
}
