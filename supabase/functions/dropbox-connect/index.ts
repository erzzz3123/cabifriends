// One-click Dropbox authorisation for the image sync — no tokens to copy or paste.
//
//   1. Open the signed link  …/functions/v1/dropbox-connect?t=<expiry>&sig=<hmac>  (made with SYNC_SECRET, valid 30 min;
//      generate one with `bash scripts/dropbox-connect-link.sh`). Without a valid link nobody can attach their own Dropbox.
//   2. It redirects to Dropbox's "Allow" page (offline access → long-lived refresh token).
//   3. Dropbox redirects back here; the code is exchanged and the refresh token is stored encrypted in Supabase Vault
//      (`dropbox_refresh_token`), where dropbox-sync reads it. It is never shown to anyone.
//
// Needs Edge Function secrets DROPBOX_APP_KEY, DROPBOX_APP_SECRET, SYNC_SECRET, and this function's URL registered
// in the Dropbox app under Settings → OAuth 2 → Redirect URIs.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};
const text = (s: string, status = 200) => new Response(s + '\n', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('SYNC_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const fresh = (t: string) => /^\d+$/.test(t) && Number(t) > Date.now() && Number(t) < Date.now() + 2 * 3600e3;

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const self = `${env('SUPABASE_URL')}/functions/v1/dropbox-connect`;
    const p = url.searchParams;

    // Step 1: signed link → Dropbox consent page.
    if (p.has('sig')) {
      const t = p.get('t') ?? '';
      if (!fresh(t) || !same(p.get('sig') ?? '', await hmac(`connect:${t}`))) return text('This link is invalid or has expired. Ask for a new one.', 403);
      const auth = new URL('https://www.dropbox.com/oauth2/authorize');
      auth.search = new URLSearchParams({
        client_id: env('DROPBOX_APP_KEY'), response_type: 'code', token_access_type: 'offline',
        redirect_uri: self, state: `${t}.${await hmac(`state:${t}`)}`, force_reapprove: 'true',
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    // Step 3: Dropbox → back here with a code.
    if (p.has('error')) return text(`Dropbox did not authorise the app: ${p.get('error_description') || p.get('error')}`, 400);
    if (p.has('code')) {
      const [t, s] = (p.get('state') ?? '').split('.');
      if (!fresh(t) || !same(s ?? '', await hmac(`state:${t}`))) return text('This sign-in has expired. Open a new connect link.', 403);
      const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${env('DROPBOX_APP_KEY')}:${env('DROPBOX_APP_SECRET')}`) },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: p.get('code')!, redirect_uri: self }),
      });
      const tok = await r.json();
      if (!r.ok || !tok.refresh_token) return text(`Dropbox did not return a refresh token (${r.status}: ${tok.error_description || tok.error || 'unknown'}).`, 502);

      const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
      const { error } = await sb.rpc('private_set_secret', { p_name: 'dropbox_refresh_token', p_value: tok.refresh_token });
      if (error) return text(`Could not store the Dropbox token: ${error.message}`, 500);

      const who = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}` } })
        .then((x) => (x.ok ? x.json() : null)).catch(() => null);
      return text(`✓ Dropbox connected${who?.email ? ` (${who.email})` : ''}.\n\nThe image sync can now read your producer folders. You can close this tab.`);
    }
    return text('Open the connect link you were given.', 400);
  } catch (e) {
    console.error(e);
    return text(`Error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
