# Shared Security Scanner

Source-of-truth deterministic agent-risk scanner shared by extensions.

The scanner detects common prompt-injection and unsafe-agent patterns:

- instruction override
- concealment
- role simulation
- secret access
- sensitive paths
- exfiltration
- network-capable commands
- remote code execution
- destructive commands
- outside-project paths
- obfuscation / hidden text

To keep each extension independently installable, this file is vendored into extension folders:

```text
prompt-shield/lib/security-scan.ts
web-search/lib/security-scan.ts
agents/lib/security-scan.ts
```

Sync vendored copies after editing:

```bash
scripts/sync-shared.sh
```

Run the scanner smoke test:

```bash
scripts/test-security-scan.mjs
```
