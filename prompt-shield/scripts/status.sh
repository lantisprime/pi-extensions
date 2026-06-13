#!/usr/bin/env bash
set -euo pipefail

# Print Prompt Shield config/state and any unapproved risky cached resources.

python3 - <<'PY'
import json
import pathlib

base = pathlib.Path.home() / '.pi/agent/prompt-shield'
config_path = base / 'config.json'
state_path = base / 'state.json'
cache_path = base / 'cache.json'

print(f'Prompt Shield directory: {base}')

if config_path.exists():
    config = json.loads(config_path.read_text())
else:
    config = {'mode': 'monitor', 'approved': {}, 'denied': {}}
active_approved = [p for p in config.get('approved', {}) if pathlib.Path(p).exists()]
active_denied = [p for p in config.get('denied', {}) if pathlib.Path(p).exists()]
stale_trust = [p for p in list(config.get('approved', {})) + list(config.get('denied', {})) if not pathlib.Path(p).exists()]
print('\nConfig:')
print(f"- mode: {config.get('mode', 'monitor')}")
print(f"- approved: {len(active_approved)} active / {len(config.get('approved', {}))} total")
print(f"- denied: {len(active_denied)} active / {len(config.get('denied', {}))} total")
if stale_trust:
    print('- stale trust entries:')
    for p in stale_trust:
        print(f"  - missing {p}")

print('\nState:')
if state_path.exists():
    state = json.loads(state_path.read_text())
    for key in ['updatedAt', 'cwd', 'riskyCount', 'dangerousCount', 'deniedCount', 'strictPermissions']:
        print(f'- {key}: {state.get(key)}')
else:
    print('- missing')

print('\nUnapproved risky cached resources:')
if not cache_path.exists():
    print('- no cache')
    raise SystemExit
cache = json.loads(cache_path.read_text())
items = list(cache.get('results', {}).values())
active_items = [r for r in items if pathlib.Path(str(r.get('path', ''))).exists()]
stale_items = [r for r in items if not pathlib.Path(str(r.get('path', ''))).exists()]
risky = [r for r in active_items if r.get('risk') != 'safe' and not r.get('approved')]
if not risky:
    print('- none')
else:
    for r in risky:
        print(f"- {r.get('risk')} score={r.get('score')} {r.get('provenance')} {r.get('kind')} {r.get('path')}")
        if r.get('llm'):
            print(f"  LLM: {r['llm'].get('classification')} - {r['llm'].get('reason')}")
        for f in r.get('findings', [])[:3]:
            print(f"  finding: {f.get('category')} - {f.get('reason')} ({f.get('match')})")
if stale_items:
    print('\nStale cached resources ignored by status:')
    for r in stale_items:
        print(f"- missing {r.get('path')}")
PY
