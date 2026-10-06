import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEmailInput } from '@/lib/alertEmail';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

const now = Date.parse('2026-10-04T05:00:00Z');
const input: AlertEmailInput = {
  householdId: 'household-1', cameraLabel: 'Lobby', alertType: 'fire',
  severity: 'critical', message: 'Fire detected',
};

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset().mockResolvedValue({ data: { sent: true }, error: null });
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('alert email delivery guards', () => {
  it.each(['email_disabled', 'below_threshold', 'no_recipients'])('allows immediate retry after %s', async reason => {
    mocks.invoke.mockResolvedValueOnce({ data: { sent: false, reason }, error: null });
    const { sendAlertEmail } = await import('@/lib/alertEmail');

    expect(await sendAlertEmail(input)).toEqual({ sent: false, reason });
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('allows immediate retry after a backend error without exposing its details', async () => {
    const privateDetail = 'Provider failure containing private authentication details';
    mocks.invoke.mockResolvedValueOnce({ data: null, error: { message: privateDetail } });
    const { sendAlertEmail } = await import('@/lib/alertEmail');

    const result = await sendAlertEmail(input);
    expect(result).toMatchObject({ sent: false, reason: 'error', message: expect.stringContaining('Could not send') });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(console.warn).not.toHaveBeenCalledWith(expect.anything(), privateDetail);
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('allows immediate retry after a network exception', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('Private network diagnostics'));
    const { sendAlertEmail } = await import('@/lib/alertEmail');

    expect(await sendAlertEmail(input)).toMatchObject({ sent: false, reason: 'error' });
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    { error: 'Provider rejected private credentials' },
    { sent: 'true' },
    null,
  ])('reports invalid or failed provider responses as errors without a cooldown', async data => {
    mocks.invoke.mockResolvedValueOnce({ data, error: null });
    const { sendAlertEmail } = await import('@/lib/alertEmail');

    expect(await sendAlertEmail(input)).toMatchObject({ sent: false, reason: 'error' });
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('forwards the verified camera snapshot to the email function', async () => {
    const { sendAlertEmail } = await import('@/lib/alertEmail');
    const snapshotDataUrl = 'data:image/jpeg;base64,dmVyaWZpZWQ=';

    expect(await sendAlertEmail({
      ...input,
      alertType: 'multimodal-distress',
      snapshotDataUrl,
    })).toEqual({ sent: true });

    expect(mocks.invoke).toHaveBeenCalledWith('send-alert-email', {
      body: expect.objectContaining({
        alertType: 'multimodal-distress',
        snapshotDataUrl,
      }),
    });
  });

  it('suppresses repeats after success until the cooldown expires', async () => {
    const { sendAlertEmail } = await import('@/lib/alertEmail');
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(await sendAlertEmail(input)).toEqual({ sent: false, reason: 'cooldown' });
    expect(mocks.invoke).toHaveBeenCalledOnce();

    vi.mocked(Date.now).mockReturnValue(now + 5 * 60 * 1000);
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('guards concurrent sends and releases the guard after a skipped response', async () => {
    let finish!: (value: { data: { sent: boolean; reason: string }; error: null }) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { sendAlertEmail } = await import('@/lib/alertEmail');

    const pending = sendAlertEmail(input);
    expect(await sendAlertEmail(input)).toEqual({ sent: false, reason: 'in_flight' });
    expect(mocks.invoke).toHaveBeenCalledOnce();

    finish({ data: { sent: false, reason: 'no_recipients' }, error: null });
    expect(await pending).toEqual({ sent: false, reason: 'no_recipients' });
    expect(await sendAlertEmail(input)).toEqual({ sent: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
