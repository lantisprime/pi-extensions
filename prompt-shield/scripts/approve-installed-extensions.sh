#!/usr/bin/env bash
set -euo pipefail

# Approve the currently installed trusted pi-extensions global extension files by hash.
# This is useful after updating/reinstalling these extensions so Prompt Shield does
# not keep reporting its own trusted defensive code as dangerous.

python3 - <<'PY'
import json
import pathlib
import hashlib
from datetime import datetime, timezone

extensions = [
    pathlib.Path.home() / '.pi/agent/extensions/permission-policy/index.ts',
    pathlib.Path.home() / '.pi/agent/extensions/prompt-shield/index.ts',
    pathlib.Path.home() / '.pi/agent/extensions/web-search/index.ts',
]
config_path = pathlib.Path.home() / '.pi/agent/prompt-shield/config.json'
config_path.parent.mkdir(parents=True, exist_ok=True)
try:
    data = json.loads(config_path.read_text())
except Exception:
    data = {}

data.setdefault('mode', 'monitor')
data.setdefault('approved', {})
data.setdefault('denied', {})

approved = []
for path in extensions:
    if not path.exists():
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    data['approved'][str(path)] = digest
    data['denied'].pop(str(path), None)
    approved.append((path, digest[:12]))

data['updatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
config_path.write_text(json.dumps(data, indent='\t') + '\n')

print(f'Updated {config_path}')
if approved:
    print('Approved installed extension hashes:')
    for path, digest in approved:
        print(f'- {path} {digest}')
else:
    print('No installed extension files found to approve.')
PY
