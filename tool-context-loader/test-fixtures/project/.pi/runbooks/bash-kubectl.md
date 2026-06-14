---
id: bash-kubectl
summary: Kubernetes safety checks for bash kubectl commands
tools: [bash]
tags: [kubernetes, safety]
match:
  commandIncludes: [kubectl, helm]
injection: tool_result
preload: index
priority: 50
maxBytes: 5000
---

# Kubernetes Runbook

SECRET BODY SHOULD NOT APPEAR IN DIAGNOSTICS.

Before destructive cluster operations, check context and namespace.
