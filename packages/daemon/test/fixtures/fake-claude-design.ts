/**
 * ADR-0044: un `claude` interactivo falso que se porta como el del spike, sin red. Pide
 * confiar en la carpeta, recibe el encargo pegado, publica un diseño en su transcript
 * y termina su turno. Deja el encargo y si heredó `CLAUDECODE` junto al script.
 */
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function writeFakeClaudeDesign(dir: string, transcripts: string): string {
  const path = join(dir, "claude")
  writeFileSync(
    path,
    `#!/usr/bin/env bash
id="$2"
out="${transcripts}/fake-cwd"
mkdir -p "$out"
f="$out/$id.jsonl"
env | grep -c '^CLAUDECODE=' > "${dir}/inherited-$id"
echo "Quick safety check: Is this a project you trust? Do you trust this folder?"
read -r _
clear
printf '\\033[1mClaude Code\\033[0m (falso)\\n? for shortcuts\\n'
while IFS= read -r line; do
  echo "$line" >> "${dir}/brief-$id"
  case "$line" in *"Al terminar responde"*) break ;; esac
done
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Artifact","input":{"action":"publish","type_url":"https://claude.ai/artifact/TYPE","title":"Tarjeta"}}]}}' >> "$f"
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Created"}]},"toolUseResult":{"created_from_type":true,"url":"https://claude.ai/artifact/DISENO1","title":"Tarjeta"}}' >> "$f"
echo '{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Listo: https://claude.ai/artifact/DISENO1"}]}}' >> "$f"
echo "? for shortcuts"
sleep 600
`,
  )
  chmodSync(path, 0o755)
  return path
}
