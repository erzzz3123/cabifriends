#!/usr/bin/env bash
# One-time Dropbox authorisation for the image sync. Gets a long-lived *refresh token* and stores it,
# with the app key and secret, as encrypted Supabase Edge Function secrets. Nothing is written to disk.
#
#   bash scripts/dropbox-auth.sh
#
# Needs: curl, python3, and the Supabase CLI logged in and linked (supabase login && supabase link).
# Without the CLI it prints the token once so you can paste it into Supabase → Edge Functions → Secrets.
set -euo pipefail

read -r  -p "Dropbox App key:    " APP_KEY
read -rs -p "Dropbox App secret: " APP_SECRET; echo

URL="https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline"
echo
echo "1. Open this page, signed in to the Dropbox account that holds the producer photos:"
echo "   $URL"
echo "2. Click Allow, then copy the access code Dropbox shows you."
(command -v open >/dev/null && open "$URL") || true
echo
read -rs -p "Paste the access code (hidden): " CODE; echo

RESPONSE=$(curl -sS https://api.dropboxapi.com/oauth2/token \
  -u "${APP_KEY}:${APP_SECRET}" \
  -d grant_type=authorization_code \
  --data-urlencode "code=${CODE}")
REFRESH=$(printf '%s' "$RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("refresh_token",""))')
if [ -z "$REFRESH" ]; then
  echo "Dropbox did not return a refresh token:"; printf '%s\n' "$RESPONSE" | sed -E 's/"access_token": *"[^"]+"/"access_token": "…"/'
  echo "Codes expire after a few minutes and work once — run the script again for a fresh one."; exit 1
fi
ACCOUNT=$(printf '%s' "$RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("account_id",""))')
echo "✓ Authorised Dropbox account ${ACCOUNT}"

if command -v supabase >/dev/null 2>&1; then
  # Passed via a temporary env file in a private dir (removed on exit) so the token never appears in shell history or `ps`.
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"
  printf 'DROPBOX_APP_KEY=%s\nDROPBOX_APP_SECRET=%s\nDROPBOX_REFRESH_TOKEN=%s\n' "$APP_KEY" "$APP_SECRET" "$REFRESH" > "$TMP/env"
  supabase secrets set --env-file "$TMP/env"
  echo "✓ Saved DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN as Supabase secrets."
else
  echo
  echo "Supabase CLI not found. Add these three in Supabase → Edge Functions → Secrets (Manage secrets):"
  echo "  DROPBOX_APP_KEY       = ${APP_KEY}"
  echo "  DROPBOX_APP_SECRET    = (the secret you typed above)"
  echo "  DROPBOX_REFRESH_TOKEN = ${REFRESH}"
  echo "Then clear this terminal (Cmd+K) — don't paste the token anywhere else."
fi
