#!/usr/bin/env bash

set -euo pipefail

agent="${1:-}"

case "$agent" in
  codexCLI|claudeCodeCLI)
    ;;
  *)
    printf 'Usage: %s <codexCLI|claudeCodeCLI>\n' "$0" >&2
    exit 64
    ;;
esac

default_exe='/mnt/c/Users/amara/AppData/Local/Programs/Pen/resources/app.asar.unpacked/out/mcp-server-windows-x64.exe'
pencil_mcp_exe="${PENCIL_MCP_WINDOWS_EXE:-$default_exe}"

if [[ ! -f "$pencil_mcp_exe" ]]; then
  printf 'Pencil MCP executable not found: %s\n' "$pencil_mcp_exe" >&2
  printf 'Set PENCIL_MCP_WINDOWS_EXE to the mounted Windows executable path.\n' >&2
  exit 127
fi

exec "$pencil_mcp_exe" --app desktop --agent "$agent"
