#!/usr/bin/env bash
# Prints a one-click Dropbox connect link, valid for 30 minutes. Needs the Supabase CLI logged in and linked.
#   bash scripts/dropbox-connect-link.sh
set -euo pipefail
SUPABASE=$(command -v supabase || echo "$HOME/.local/bin/supabase")
REF=$(cat supabase/.temp/project-ref)
SECRET=$("$SUPABASE" db query --linked "select decrypted_secret s from vault.decrypted_secrets where name='sync_secret'" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["rows"][0]["s"])')
T=$(( ($(date +%s) + 1800) * 1000 ))
SIG=$(printf 'connect:%s' "$T" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
echo "https://${REF}.supabase.co/functions/v1/dropbox-connect?t=${T}&sig=${SIG}"
