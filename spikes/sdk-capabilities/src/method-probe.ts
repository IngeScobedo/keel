/**
 * Spike de ADR-0021: ¿puede Keel conducir el método sobre el harness del
 * proyecto? Mide con el `claude` instalado y haiku, sobre un repo de prueba que
 * el propio spike crea en un directorio temporal:
 *
 *   1. `settingSources: ["project"]` carga CLAUDE.md, skills y hooks del repo.
 *   2. Un `permissions.allow` del proyecto se salta `canUseTool`.
 *   3. Un hook PreToolUse de Keel con `permissionDecision: "ask"` lo devuelve
 *      al gate.
 *   4. Un plugin local de Keel aporta skills y agentes sin tocar el repo.
 *   5. El modo `plan` del SDK: qué corre, qué pide permiso, qué escribe.
 *
 *   bun spikes/sdk-capabilities/src/method-probe.ts
 *
 * Escribe un resumen JSON por prueba en stdout. Gasta unos centavos de la
 * suscripción.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  type HookCallback,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

const root = mkdtempSync(join(tmpdir(), "keel-method-probe-"))
const proj = join(root, "proj")
const plugin = join(root, "plugin")

function file(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

file(
  join(proj, "CLAUDE.md"),
  "# Proyecto de prueba\nLa palabra clave del proyecto es ZORZAL. Si te la preguntan, respóndela.\n",
)
file(
  join(proj, ".claude", "settings.json"),
  JSON.stringify({
    permissions: { allow: ["Bash(touch:*)"] },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/no-prohibido.sh" },
          ],
        },
      ],
    },
  }),
)
file(
  join(proj, ".claude", "hooks", "no-prohibido.sh"),
  '#!/bin/sh\ninput=$(cat)\ncase "$input" in *prohibido*) echo "hook del proyecto: prohibido no se permite" >&2; exit 2;; esac\nexit 0\n',
)
chmodSync(join(proj, ".claude", "hooks", "no-prohibido.sh"), 0o755)
file(
  join(proj, ".claude", "skills", "saludo", "SKILL.md"),
  "---\nname: saludo\ndescription: Úsala cuando pidan saludar al estilo del proyecto.\n---\nResponde exactamente: «Hola desde la skill del proyecto».\n",
)
file(join(proj, "leeme.txt"), "hola\n")
execFileSync("git", ["init", "-q"], { cwd: proj })
execFileSync("git", ["add", "-A"], { cwd: proj })
execFileSync(
  "git",
  ["-c", "user.name=spike", "-c", "user.email=spike@local", "commit", "-qm", "base"],
  { cwd: proj },
)

file(
  join(plugin, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "keel-method", version: "0.0.1", description: "Método de Keel" }),
)
file(
  join(plugin, "skills", "grilling", "SKILL.md"),
  "---\nname: grilling\ndescription: Úsala cuando haya que interrogar al humano para afilar un plan.\n---\nResponde exactamente: «grilling de Keel activo».\n",
)
file(
  join(plugin, "agents", "keel-reviewer.md"),
  "---\nname: keel-reviewer\ndescription: Revisor adversarial de sólo lectura de Keel.\ntools: Read, Grep, Glob\n---\nEres el reviewer de Keel. Responde exactamente «reviewer de Keel».\n",
)

const env = { ...process.env } as Record<string, string>
delete env.ANTHROPIC_API_KEY
const binary = [process.env.KEEL_CLAUDE_PATH, join(homedir(), ".local", "bin", "claude")].find(
  (p) => p && existsSync(p),
)

type Result = {
  init: { skills?: unknown; agents?: unknown; plugins?: unknown; permissionMode?: unknown }
  asked: string[]
  hookDenied: string[]
  bash: string[]
  result: string
  created: string[]
}

async function probe(
  prompt: string,
  extra: Partial<Options>,
  keelGate = false,
  denyAll = false,
): Promise<Result> {
  const r: Result = { init: {}, asked: [], hookDenied: [], bash: [], result: "", created: [] }
  // El gate de Keel como hook: lo que no sea de sólo lectura vuelve a canUseTool.
  const keelHook: HookCallback = async (input) => {
    const i = input as { tool_name?: string }
    if (["Read", "Glob", "Grep", "Skill", "Task", "Agent"].includes(String(i.tool_name))) return {}
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Keel decide",
      },
    }
  }
  const input = (async function* () {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage
    await new Promise((resolve) => setTimeout(resolve, 120_000))
  })()
  const q = query({
    prompt: input,
    options: {
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      cwd: proj,
      env,
      model: "haiku",
      maxTurns: 8,
      permissionMode: "default",
      canUseTool: async (tool, toolInput) => {
        r.asked.push(`${tool}:${String((toolInput as { command?: string }).command ?? "")}`)
        if (denyAll) return { behavior: "deny", message: "Keel: etapa de sólo lectura" }
        return { behavior: "allow", updatedInput: toolInput }
      },
      ...(keelGate ? { hooks: { PreToolUse: [{ hooks: [keelHook] }] } } : {}),
      ...extra,
    },
  })
  for await (const m of q as AsyncIterable<SDKMessage>) {
    const raw = m as unknown as Record<string, unknown>
    if (raw.type === "system" && raw.subtype === "init")
      // Sólo lo que mide el spike: la lista completa trae también las skills del binario.
      r.init = {
        skills: ((raw.skills ?? []) as string[]).filter((s) =>
          ["saludo", "grilling"].some((x) => s.includes(x)),
        ),
        agents: ((raw.agents ?? []) as string[]).filter((a) => a.includes("keel")),
        plugins: ((raw.plugins ?? []) as { name: string }[])
          .map((p) => p.name)
          .filter((n) => n.includes("keel")),
        permissionMode: raw.permissionMode,
      }
    if (raw.type === "assistant")
      for (const c of (raw.message as { content: Record<string, unknown>[] }).content)
        if (c.type === "tool_use" && c.name === "Bash")
          r.bash.push(String((c.input as { command?: string }).command))
    if (raw.type === "user") {
      const content = (raw.message as { content?: unknown }).content
      if (Array.isArray(content))
        for (const c of content as Record<string, unknown>[])
          if (c.type === "tool_result" && String(JSON.stringify(c.content)).includes("prohibido"))
            r.hookDenied.push(String(JSON.stringify(c.content)).slice(0, 160))
    }
    if (raw.type === "result") {
      r.result = String(raw.result ?? "").slice(0, 300)
      break
    }
  }
  r.created = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "plan.txt", "plan2.txt"].filter((f) =>
    existsSync(join(proj, f)),
  )
  return r
}

const which = (process.env.PROBES ?? "1,2,3,4,5").split(",")
const out: Record<string, unknown> = { root, binary }
if (which.includes("1"))
  out.p1_harness_y_allow = await probe(
    "Dime la palabra clave del proyecto. Luego ejecuta con Bash `touch a.txt`. Después usa la skill saludo.",
    { settingSources: ["project"] },
  )
if (which.includes("2"))
  out.p2_gate_keel_como_hook = await probe(
    "Ejecuta con Bash `touch b.txt`.",
    {
      settingSources: ["project"],
    },
    true,
  )
if (which.includes("3"))
  out.p3_hook_del_proyecto = await probe("Ejecuta con Bash `echo prohibido`.", {
    settingSources: ["project"],
  })
if (which.includes("4"))
  out.p4_plugin_de_keel = await probe(
    "Usa la skill grilling. Luego delega en el agente keel-reviewer y repite lo que responda.",
    { settingSources: ["project"], plugins: [{ type: "local", path: plugin }] },
  )
if (which.includes("5"))
  out.p5_modo_plan = await probe(
    "Ejecuta con Bash `ls`, luego `touch c.txt`, y luego crea el archivo plan.txt con el texto hola usando la herramienta Write.",
    { settingSources: ["project"], permissionMode: "plan" },
    true,
  )
if (which.includes("6"))
  out.p6_allow_sin_gate_keel = await probe(
    "Ejecuta con Bash exactamente `touch d.txt` (sólo ese comando, sin encadenar nada) y no hagas nada más.",
    { settingSources: ["project"] },
  )
if (which.includes("7"))
  // Lo que hará Keel en una etapa de sólo lectura: modo plan y negar todo lo que llegue al gate.
  out.p7_plan_con_keel_negando = await probe(
    "Ejecuta con Bash `ls`, luego `touch e.txt`, y luego crea plan2.txt con el texto hola usando Write.",
    { settingSources: ["project"], permissionMode: "plan" },
    false,
    true,
  )
console.log(JSON.stringify(out, null, 2))
process.exit(0)
