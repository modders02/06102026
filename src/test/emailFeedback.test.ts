import { describe, expect, it, vi } from 'vitest';
import { emailFailureMessage, emailSkipMessage } from '@/lib/emailFeedback';

const failedResponse = (body: unknown, status = 500) => ({
  context: { status, text: vi.fn().mockResolvedValue(JSON.stringify(body)) },
});

describe('email failure feedback', () => {
  it.each(['Brevo sender lookup failed', 'Email provider request failed'])('identifies the provider error without mistaking it for an expired app login: %s', async description => {
    const error = failedResponse({ error: description, status: 401, details: JSON.stringify({ message: 'Key not found', code: 'unauthorized' }) }, 401);
    const message = await emailFailureMessage(error);
    expect(message).toContain('Brevo rejected the server API key.');
    expect(message).toContain('Supabase Edge Function Secrets');
    expect(message).not.toContain('details');
    expect(message).not.toContain('Key not found');
  });

  it.each(['An SMTP key was configured.', 'Email provider not configured.'])('explains configuration failures: %s', async error => {
    expect(await emailFailureMessage(failedResponse({ error }, 503))).toContain('Set BREVO_API_KEY to a Brevo API key');
  });

  it('gives a sender-verification instruction', async () => {
    expect(await emailFailureMessage(failedResponse({ error: 'No verified Brevo sender is available' }, 422))).toBe('Verify a sender email address in Brevo, then try again.');
  });

  it('asks for app sign-in for an authentication error unrelated to Brevo', async () => {
    expect(await emailFailureMessage(failedResponse({ error: 'Unauthorized' }, 401))).toContain('Sign in again');
  });

  it('handles unreadable response bodies and network exceptions without leaking their contents', async () => {
    const error = { context: { text: vi.fn().mockRejectedValue(new Error('secret response')) } };
    expect(await emailFailureMessage(error)).toBe('The test email could not be sent. Please try again.');
    expect(await emailFailureMessage(new Error('private provider credential'))).not.toContain('credential');
  });

  it('explains skipped sends in plain language', () => {
    expect(emailSkipMessage('no_recipients')).toContain('Add an email recipient');
    expect(emailSkipMessage('email_disabled')).toContain('Turn on Email Alerts');
    expect(emailSkipMessage('below_threshold')).toContain('severity threshold');
  });
});
