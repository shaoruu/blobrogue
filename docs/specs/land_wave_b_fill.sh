#!/bin/bash
set -euo pipefail
mkdir -p /workspace/blobrogue/docs/specs
curl -fsSL -o /workspace/blobrogue/docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md \
  "https://raw.githubusercontent.com/shaoruu/blobrogue/quill/wave-b-numeric-fill/docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md"
test -s /workspace/blobrogue/docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md
rg -n "Remember Me|IDENTITY|Program mix|sole Wave B" /workspace/blobrogue/docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md | head
echo "LANDED $(wc -c </workspace/blobrogue/docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md) bytes"
