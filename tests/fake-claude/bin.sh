#!/bin/sh
# Fake Claude Code binary: single node process (tsx registered in-process by absolute path, independent of cwd)
# so signals behave like a real binary.
DIR="$(cd "${0%/*}" && pwd)"
exec node --import "$DIR/../../node_modules/tsx/dist/loader.mjs" "$DIR/src/main.ts" "$@"
