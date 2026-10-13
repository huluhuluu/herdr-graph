#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 18+ is required. Install it and add node to PATH.' >&2
  exit 1
fi
exec node "$script_dir/src/install.js" "$@"
