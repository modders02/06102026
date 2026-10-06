import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationSettings from '@/components/household/NotificationSettings';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          order: async () => ({ data: [{ id: 'recipient', email: 'recipient@example.com', enabled: true }], error: null }),
        }),
      }),
    }),
  },
}));

beforeEach(() => { mocks.invoke.mockReset(); });
afterEach(cleanup);

async function openSettings() {
  render(<NotificationSettings householdId="household" />);
  await screen.findByText('recipient@example.com');
  return screen.getByRole('button', { name: 'Send test email' });
}

describe('notification test email', () => {
  it('replaces the screenshot JSON error with an instruction to update the live key', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: { context: {
      status: 401,
      text: async () => JSON.stringify({ error: 'Brevo sender lookup failed', status: 401, details: '{"message":"Key not found","code":"unauthorized"}' }),
    } } });
    const button = await openSettings();
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Brevo rejected the server API key.'));
    expect(screen.getByRole('status')).not.toHaveTextContent('details');
    expect(button).toBeEnabled();
    expect(mocks.invoke).toHaveBeenCalledWith('send-alert-email', expect.objectContaining({ body: expect.objectContaining({ householdId: 'household', severity: 'critical' }) }));
  });

  it('prevents duplicate test emails while waiting and restores the button after success', async () => {
    let finish!: (result: { data: { sent: boolean; recipients: number }; error: null }) => void;
    mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const button = await openSettings();
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    finish({ data: { sent: true, recipients: 1 }, error: null });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sent to 1 recipient(s).'));
    expect(button).toBeEnabled();
  });

  it('allows retry after a network failure', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('private network diagnostic'));
    mocks.invoke.mockResolvedValueOnce({ data: { sent: true, recipients: 1 }, error: null });
    const button = await openSettings();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The test email could not be sent.'));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sent to 1 recipient(s).'));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
