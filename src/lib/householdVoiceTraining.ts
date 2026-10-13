import { supabase } from '@/integrations/supabase/client';

export const VOICE_BUCKET = 'household-wake-word-audio';
export const POSITIVE_MINIMUM = 3;
export const UNKNOWN_MINIMUM = 5;

export interface HouseholdVoiceWord { id: string; phrase: string }
export interface HouseholdVoiceStatus {
  active_household_id: string | null;
  words: Array<HouseholdVoiceWord & { key: string }>;
  sample_ids: Record<string, string[]>;
  keywords: Record<string, number>;
  ready_keywords: string[];
  negative_ready: boolean;
  open_set_ready: boolean;
  error?: string | null;
}

const local = 'http://127.0.0.1:5000';

export function voiceKey(phrase: string): string | null {
  const normalized = phrase.trim().toLowerCase();
  return /^[a-z][a-z0-9_ -]{1,31}$/.test(normalized)
    ? normalized.replace(/ /g, '_') : null;
}

export function validVoiceWords(words: HouseholdVoiceWord[]): HouseholdVoiceWord[] {
  const keys = new Set<string>();
  return words.filter(word => {
    const key = voiceKey(word.phrase);
    if (!key || key === 'unknown' || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function localRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(local + path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Local MSDS KWS service returned HTTP ${res.status}.`);
  }
  return res.json() as Promise<T>;
}

export async function activateHouseholdVoice(householdId: string, words: HouseholdVoiceWord[]) {
  return localRequest<HouseholdVoiceStatus>('/kws/household/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ household_id: householdId, words: validVoiceWords(words) }),
  });
}

export async function deactivateHouseholdVoice() {
  await localRequest('/kws/household/deactivate', { method: 'POST' });
}

export async function getHouseholdVoiceStatus() {
  return localRequest<HouseholdVoiceStatus>('/kws/status');
}

export async function synchronizeHouseholdVoice(
  householdId: string,
  words: HouseholdVoiceWord[],
): Promise<HouseholdVoiceStatus> {
  const eligible = validVoiceWords(words);
  const activated = await activateHouseholdVoice(householdId, eligible);
  const uploaded = new Set<string>();
  const wordKeys = [{ id: 'unknown', key: 'unknown' },
    ...eligible.map(w => ({ id: w.id, key: voiceKey(w.phrase)! }))];
  for (const word of wordKeys) {
    const folder = `${householdId}/${word.id}`;
    const { data: files, error: listError } = await supabase.storage.from(VOICE_BUCKET)
      .list(folder, { limit: 100 });
    if (listError) throw new Error(`Could not load household voice recordings: ${listError.message}`);
    const existing = new Set(activated.sample_ids?.[word.key] ?? []);
    for (const file of files || []) {
      const match = /^([0-9a-f]{32})\.wav$/.exec(file.name);
      if (!match || existing.has(match[1]) || uploaded.has(`${word.key}/${match[1]}`)) continue;
      const { data: wav, error } = await supabase.storage.from(VOICE_BUCKET).download(`${folder}/${file.name}`);
      if (error || !wav) throw new Error(error?.message || 'Could not download a household recording.');
      await enrollHouseholdSample(householdId, word.id, match[1], wav);
      uploaded.add(`${word.key}/${match[1]}`);
    }
  }
  return getHouseholdVoiceStatus();
}

export async function enrollHouseholdSample(
  householdId: string, wordId: string, sampleId: string, audio: Blob,
) {
  const data = new FormData();
  data.append('household_id', householdId);
  data.append('word_id', wordId);
  data.append('sample_id', sampleId);
  data.append('audio', audio, 'training.wav');
  return localRequest<{ success: boolean; templates: number; ready: boolean }>(
    '/kws/household/enroll', { method: 'POST', body: data },
  );
}

export async function uploadHouseholdSample(householdId: string, wordId: string, audio: Blob) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const path = `${householdId}/${wordId}/${id}.wav`;
  const bucket = supabase.storage.from(VOICE_BUCKET);
  const { error } = await bucket.upload(path, audio, {
    contentType: 'audio/wav', upsert: false,
  });
  if (error) throw new Error(`Recording could not be shared with your household: ${error.message}`);
  try {
    await enrollHouseholdSample(householdId, wordId, id, audio);
  } catch (e) {
    // Supabase remains the source of truth: the next successful sync will
    // enroll the saved sample into this desktop's local engine.
    throw new Error(`Recording saved to household, but local training failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function deleteHouseholdVoiceSamples(householdId: string, wordId: string) {
  const folder = `${householdId}/${wordId}`;
  const store = supabase.storage.from(VOICE_BUCKET);
  const { data, error } = await store.list(folder, { limit: 100 });
  if (error) throw new Error(error.message);
  const files = (data || []).filter(entry => entry.name.endsWith('.wav'))
    .map(entry => `${folder}/${entry.name}`);
  if (files.length) {
    const { error: removal } = await store.remove(files);
    if (removal) throw new Error(removal.message);
  }
}

export function pcmWavFromAudio(buffer: AudioBuffer): Blob {
  const rate = 16000;
  const source = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) source[i] += samples[i] / buffer.numberOfChannels;
  }
  const total = Math.floor(source.length * rate / buffer.sampleRate);
  const downsampled = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const position = i * buffer.sampleRate / rate;
    const index = Math.floor(position);
    const mix = position - index;
    downsampled[i] = source[index] * (1 - mix) + (source[Math.min(index + 1, source.length - 1)] || 0) * mix;
  }
  const peak = downsampled.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (peak < 0.018) throw new Error('No clear speech was recorded. Move closer to the microphone and try again.');
  const threshold = Math.max(0.014, peak * 0.10);
  let first = 0;
  let last = downsampled.length - 1;
  while (first < last && Math.abs(downsampled[first]) < threshold) first++;
  while (last > first && Math.abs(downsampled[last]) < threshold) last--;
  first = Math.max(0, first - 1600);
  last = Math.min(downsampled.length, last + 1600);
  const segment = downsampled.subarray(first, last);
  const seconds = segment.length / rate;
  if (seconds < 0.3 || seconds > 2.5) {
    throw new Error('Say one short wake word or phrase (0.3 to 2.5 seconds), then try again.');
  }
  const wav = new ArrayBuffer(44 + segment.length * 2);
  const view = new DataView(wav);
  function ascii(offset: number, value: string) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }
  ascii(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true);
  ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, segment.length * 2, true);
  for (let i = 0; i < segment.length; i++) {
    const value = Math.max(-1, Math.min(0.999969, segment[i]));
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return new Blob([wav], { type: 'audio/wav' });
}

export async function decodeRecordedWakeWord(blob: Blob): Promise<Blob> {
  const audioContext = new AudioContext();
  try {
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return pcmWavFromAudio(buffer);
  } finally {
    await audioContext.close();
  }
}
