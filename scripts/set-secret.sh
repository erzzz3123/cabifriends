#!/usr/bin/env bash
# Stores one Edge Function secret in Supabase without it touching shell history, `ps` or the repo.
#   bash scripts/set-secret.sh AIRTABLE_TOKEN
set -euo pipefail
NAME=${1:?usage: set-secret.sh NAME}
SUPABASE=$(command -v supabase || echo "$HOME/.local/bin/supabase")
read -rs -p "Paste the value for ${NAME} (hidden), then press Enter: " VALUE; echo
[ -n "$VALUE" ] || { echo "Nothing entered."; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"
printf '%s=%s\n' "$NAME" "$VALUE" > "$TMP/env"
"$SUPABASE" secrets set --env-file "$TMP/env" >/dev/null
echo "✓ Saved ${NAME} in Supabase → Edge Functions → Secrets."
