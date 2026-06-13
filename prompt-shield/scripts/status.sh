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
print('\nConfig:')
print(f"- mode: {config.get('mode', 'monitor')}")
print(f"- approved: {len(config.get('approved', {}))}")
print(f"- denied: {len(config.get('denied', {}))}")

print('\nState:')
if state_path.exists():
    state = json.loads(state_path.read_text())
    for key in ['updatedAt', 'cwd', 'riskyCount', 'dangerousCount', 'strictPermissions']:
        print(f'- {key}: {state.get(key)}')
else:
    print('- missing')

print('\nUnapproved risky cached resources:')
if not cache_path.exists():
    print('- no cache')
    raise SystemExit
cache = json.loads(cache_path.read_text())
items = list(cache.get('results', {}).values())
risky = [r for r in items if r.get('risk') != 'safe' and not r.get('approved')]
if not risky:
    print('- none')
else:
    for r in risky:
        print(f"- {r.get('risk')} score={r.get('score')} {r.get('provenance')} {r.get('kind')} {r.get('path')}")
        if r.get('llm'):
            print(f"  LLM: {r['llm'].get('classification')} - {r['llm'].get('reason')}")
        for f in r.get('findings', [])[:3]:
            print(f"  finding: {f.get('category')} - {f.get('reason')} ({f.get('match')})")
PY
