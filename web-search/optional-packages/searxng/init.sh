#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  echo ".env already exists; leaving it unchanged." >&2
  exit 0
fi

if command -v openssl >/dev/null 2>&1; then
  secret="$(openssl rand -hex 32)"
else
  secret="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
fi

cp .env.example .env
python3 - "$secret" <<'PY'
from pathlib import Path
import sys
secret = sys.argv[1]
path = Path('.env')
text = path.read_text()
path.write_text(text.replace('replace-with-random-secret', secret))
PY

echo "Created .env with a random SEARXNG_SECRET."
echo "Next: docker compose up -d"
