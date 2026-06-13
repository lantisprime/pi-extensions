#!/usr/bin/env bash
set -euo pipefail

# Approve the currently installed trusted pi-extensions global extension files by hash.
# This is useful after updating/reinstalling these extensions so Prompt Shield does
# not keep reporting its own trusted defensive code as dangerous. The script also
# refreshes cached approval flags and current strict-permission state so the
# permission-policy extension immediately observes the updated approvals.

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
base = pathlib.Path.home() / '.pi/agent/prompt-shield'
config_path = base / 'config.json'
cache_path = base / 'cache.json'
state_path = base / 'state.json'
base.mkdir(parents=True, exist_ok=True)
now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

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

data['updatedAt'] = now
config_path.write_text(json.dumps(data, indent='\t') + '\n')

try:
    cache = json.loads(cache_path.read_text())
except Exception:
    cache = {'updatedAt': now, 'results': {}}

results = cache.setdefault('results', {})
for path, _short_digest in approved:
    key = str(path)
    result = results.get(key)
    if not isinstance(result, dict):
        continue
    digest = data['approved'][key]
    # This helper explicitly trusts the currently installed extension files. If
    # cache details were from the previous hash, advance the cached hash so the
    # state calculation below does not remain strict solely because of stale
    # metadata for these trusted installed files.
    result['hash'] = digest
    result['approved'] = True
    result['denied'] = False

for collection_name in ['approved', 'denied']:
    collection = data.get(collection_name, {})
    for key in list(collection):
        if not pathlib.Path(key).exists():
            del collection[key]

for key, result in list(results.items()):
    if not isinstance(result, dict):
        continue
    cached_path = pathlib.Path(str(result.get('path') or key))
    if not cached_path.exists():
        # Drop stale cache entries for resources that no longer exist; they are
        # not active risk and should not keep permission-policy strict.
        del results[key]
        continue
    digest = result.get('hash')
    result['approved'] = bool(digest and data.get('approved', {}).get(key) == digest)
    result['denied'] = bool(digest and data.get('denied', {}).get(key) == digest)
    if result['denied']:
        result['risk'] = 'dangerous'

cache['updatedAt'] = now
cache_path.write_text(json.dumps(cache, indent='\t') + '\n')

try:
    state = json.loads(state_path.read_text())
except Exception:
    state = {}

items = [r for r in results.values() if isinstance(r, dict)]
risky = [r for r in items if r.get('risk') != 'safe' and not r.get('approved')]
dangerous = [r for r in risky if r.get('risk') == 'dangerous']
denied = [r for r in risky if r.get('denied')]
state.update({
    'updatedAt': now,
    'riskyCount': len(risky),
    'dangerousCount': len(dangerous),
    'deniedCount': len(denied),
    'strictPermissions': len(risky) > 0,
})
state_path.write_text(json.dumps(state, indent='\t') + '\n')

print(f'Updated {config_path}')
if approved:
    print('Approved installed extension hashes:')
    for path, digest in approved:
        print(f'- {path} {digest}')
else:
    print('No installed extension files found to approve.')
print(f'Updated {cache_path}')
print(f'Updated {state_path}: risky={len(risky)} dangerous={len(dangerous)} strictPermissions={len(risky) > 0}')
if risky:
    print('Remaining unapproved risky cached resources:')
    for result in risky:
        print(f"- {result.get('risk')} {result.get('path')}")
PY
