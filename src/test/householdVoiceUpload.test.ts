import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: mocks.from } },
}));
import { uploadHouseholdSample } from '@/lib/householdVoiceTraining';

beforeEach(() => {
  mocks.upload.mockReset().mockResolvedValue({ error: null });
  mocks.from.mockReset().mockReturnValue({ upload: mocks.upload });
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
});
