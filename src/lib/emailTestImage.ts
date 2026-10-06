const FALLBACK_TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

/**
 * Build a small local image used only by the Household "Send test email"
 * action. This verifies the exact Brevo attachment path without requiring a
 * real emergency or access to a live camera.
 */
export function createEmailTestImage(): string {
  if (typeof document === 'undefined') return FALLBACK_TEST_IMAGE;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const ctx = canvas.getContext('2d');
    if (!ctx) return FALLBACK_TEST_IMAGE;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, 0, canvas.width, 12);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial, sans-serif';
    ctx.fillText('MSDS EMAIL TEST', 36, 92);
    ctx.font = '18px Arial, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Verification image attachment', 36, 130);
    ctx.fillText(new Date().toISOString(), 36, 168);

    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(44, 220, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '16px Arial, sans-serif';
    ctx.fillText('Attachment pipeline active', 64, 226);

    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return FALLBACK_TEST_IMAGE;
  }
}
