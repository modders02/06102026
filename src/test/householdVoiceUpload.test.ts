import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn(), from: vi.fn(), list: vi.fn(), download: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: mocks.from } },
}));
import { uploadHouseholdSample, deleteHouseholdVoiceSample, replaceHouseholdVoiceSample, synchronizeHouseholdVoice } from '@/lib/householdVoiceTraining';

beforeEach(() => {
  mocks.upload.mockReset().mockResolvedValue({ error: null });
  mocks.remove.mockReset().mockResolvedValue({ error: null });
  mocks.list.mockReset().mockResolvedValue({ data: [], error: null });
  mocks.download.mockReset();
  mocks.from.mockReset().mockReturnValue({
    upload: mocks.upload, remove: mocks.remove, list: mocks.list, download: mocks.download,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('household voice upload validation', () => {
  it('never uploads a rejected microphone sample', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ detail: 'The speech was too quiet.' }),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(uploadHouseholdSample('hh', 'word', new Blob(['bad'])))
      .rejects.toThrow('The speech was too quiet.');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain('/kws/household/validate');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('validates a sample before uploading and enrolling it', async () => {
    const events: string[] = [];
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      events.push(url.endsWith('/validate') ? 'validate' : 'enroll');
      return { ok: true, json: async () => ({ success: true, templates: 1 }) };
    });
    mocks.upload.mockImplementation(async () => { events.push('upload'); return { error: null }; });
    vi.stubGlobal('fetch', fetch);
    const crypto = { randomUUID: () => '11111111-1111-4111-8111-111111111111' };
    vi.stubGlobal('crypto', crypto);
    await uploadHouseholdSample('hh', 'word', new Blob(['wav'], { type: 'audio/wav' }));
    expect(events).toEqual(['validate', 'upload', 'enroll']);
    expect(mocks.upload.mock.calls[0][0]).toBe('hh/word/11111111111141118111111111111111.wav');
  });

  it('deletes a sample from private Supabase storage before removing its local template', async () => {
    const events: string[] = [];
    mocks.remove.mockImplementation(async () => {
      events.push('cloud-remove');
      return { error: null };
    });
    const request = vi.fn(async () => {
      events.push('local-remove');
      return { ok: true, json: async () => ({ success: true, deleted: true }) };
    });
    vi.stubGlobal('fetch', request);
    const sampleId = '1'.repeat(32);
    await deleteHouseholdVoiceSample('household', 'word', sampleId);
    expect(mocks.remove).toHaveBeenCalledWith([`household/word/${sampleId}.wav`]);
    expect(request.mock.calls[0][0]).toContain('/kws/household/sample/delete');
    expect(events).toEqual(['cloud-remove', 'local-remove']);
  });

  it('does not remove local templates when Supabase deletion fails', async () => {
    mocks.remove.mockResolvedValue({ error: { message: 'Permission denied' } });
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(deleteHouseholdVoiceSample('household', 'word', '2'.repeat(32)))
      .rejects.toThrow('Permission denied');
    expect(request).not.toHaveBeenCalled();
    await expect(deleteHouseholdVoiceSample('household', 'word', '../bad'))
      .rejects.toThrow('Invalid training sample');
  });

  it('preserves the prior sample when replacement validation fails', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ detail: 'Speech was too quiet.' }),
    });
    vi.stubGlobal('fetch', request);
    await expect(replaceHouseholdVoiceSample('household', 'word', '3'.repeat(32), new Blob(['bad'])))
      .rejects.toThrow('Speech was too quiet.');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('saves a replacement before deleting the old sample from Supabase', async () => {
    const events: string[] = [];
    const request = vi.fn(async (url: string) => {
      events.push(url.endsWith('/validate') ? 'validate'
        : url.endsWith('/enroll') ? 'enroll' : 'local-remove');
      return { ok: true, json: async () => ({ success: true }) };
    });
    mocks.upload.mockImplementation(async () => {
      events.push('upload');
      return { error: null };
    });
    mocks.remove.mockImplementation(async () => {
      events.push('cloud-remove');
      return { error: null };
    });
    vi.stubGlobal('fetch', request);
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
    await replaceHouseholdVoiceSample('household', 'word', '4'.repeat(32),
      new Blob(['wav'], { type: 'audio/wav' }));
    expect(events).toEqual(['validate', 'upload', 'enroll', 'cloud-remove', 'local-remove']);
  });

  it('reconciles locally cached recordings with cloud storage including deletions', async () => {
    const sampleId = 'a'.repeat(32);
    mocks.list.mockImplementation(async (folder: string) => ({
      data: folder.endsWith('/word') ? [{ name: `${sampleId}.wav` }] : [],
      error: null,
    }));
    const requests: string[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/activate')) return {
        ok: true,
        json: async () => ({ active_household_id: 'household',
          sample_ids: { help_me: [sampleId, 'b'.repeat(32)], unknown: ['c'.repeat(32)] } }),
      };
      if (url.endsWith('/reconcile')) {
        const manifest = JSON.parse(init?.body as string);
        expect(manifest.samples).toEqual({ unknown: [], word: [sampleId] });
      }
      return { ok: true, json: async () => ({ success: true, sample_ids: { help_me: [sampleId], unknown: [] } }) };
    });
    vi.stubGlobal('fetch', request);
    await synchronizeHouseholdVoice('household', [{ id: 'word', phrase: 'help me' }]);
    expect(requests.some(url => url.endsWith('/reconcile'))).toBe(true);
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
