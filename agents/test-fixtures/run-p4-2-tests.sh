#!/usr/bin/env bash
exec node --experimental-strip-types "$(dirname "$0")/test-bg-preflight.mjs"
