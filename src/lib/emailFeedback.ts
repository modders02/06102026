type EmailFailure = {
  context?: { status?: number; clone?: () => { text: () => Promise<string> }; text?: () => Promise<string> };
};

/** Turn backend failures into actionable messages without displaying raw responses. */
export async function emailFailureMessage(error: unknown): Promise<string> {
  const context = (error as EmailFailure | null)?.context;
  let body: { error?: string; status?: number } | null = null;
  try {
    const response = context?.clone ? context.clone() : context;
    const raw = await response?.text?.();
    if (raw) body = JSON.parse(raw);
  } catch { /* An unreadable response still gets a useful fallback. */ }

  const description = typeof body?.error === 'string' ? body.error : '';
  const providerFailure = /brevo|provider request/i.test(description);
  if (providerFailure && body?.status === 401) {
    return 'Brevo rejected the server API key. Update BREVO_API_KEY in Supabase Edge Function Secrets, then try again.';
  }
  if (/SMTP key|provider not configured/i.test(description)) {
    return 'Email is not configured. Set BREVO_API_KEY to a Brevo API key in Supabase Edge Function Secrets.';
  }
  if (/verified Brevo sender/i.test(description)) {
    return 'Verify a sender email address in Brevo, then try again.';
  }
  if (/load email recipients/i.test(description)) {
    return 'Could not load email recipients. Check your household access and try again.';
  }
  if (/unauthorized/i.test(description) || context?.status === 401) {
    return 'Your session could not be verified. Sign in again, then retry the test email.';
  }
  if (providerFailure) {
    return 'Brevo could not send the email. Check your verified sender and Brevo account settings.';
  }
  return 'The test email could not be sent. Please try again.';
}

export function emailSkipMessage(reason?: string): string {
  switch (reason) {
    case 'no_recipients': return 'Add an email recipient to receive alerts, then send the test again.';
    case 'email_disabled': return 'Turn on Email Alerts, then send the test again.';
    case 'below_threshold': return 'This alert is below your selected email severity threshold.';
    default: return 'The email was not sent. Check your notification settings and try again.';
  }
}
