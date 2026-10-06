# Brevo alert email setup

Camera safety alerts use the Supabase `send-alert-email` function. The Brevo
credential belongs in the function's server secrets. It is not a Vite setting.

1. In Brevo, open **Settings > SMTP & API > API Keys** and generate an API key.
   SMTP keys do not authenticate this REST integration. Verify a sender address
   in Brevo, or set `BREVO_SENDER_EMAIL` to an already verified sender.
2. Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill
   in `BREVO_API_KEY`. The `.env` file is ignored by Git.
3. Sign in to the project's Supabase account and set the secrets:

   ```powershell
   npx.cmd supabase login
   npx.cmd supabase secrets set --env-file supabase/functions/.env --project-ref nwksvvwlwacauysiqqkh
   npx.cmd supabase functions deploy send-alert-email --project-ref nwksvvwlwacauysiqqkh --use-api
   ```

   Alternatively, enter `BREVO_API_KEY` in the project's **Edge Functions > Secrets**
   page. Adding a secret alone does not deploy a missing or changed function.
4. In the app, open **Household > Notifications**, turn on **Email Alerts**, and
   add the email addresses that should receive alerts. Account and household
   member email addresses are not automatically added as notification recipients.
5. Click **Send test email + image**. A successful result means Brevo accepted
   both the message and the attachment payload. Confirm that the email contains
   the attached `msds-verification.jpg` (or PNG fallback), then check Brevo
   delivery logs if the message does not arrive.
6. Trigger one controlled high/critical camera event. When that event has a
   captured camera snapshot, the automatic alert email now attaches the same
   frame that is retained with the alert in MSDS.

The signed-in account must belong to the household. Automatic alerts send at high
or critical severity and respect the household's email enablement and severity
threshold. Successful sends are grouped per camera and alert type for five minutes;
failed or skipped sends can retry immediately after the setup is corrected.
Verification images are accepted only as JPEG, PNG, or WebP data URLs and are
bounded in size by the Edge Function before they are forwarded to Brevo.

References: [Brevo API authentication](https://developers.brevo.com/docs/api-key-authentication)
and [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets).
