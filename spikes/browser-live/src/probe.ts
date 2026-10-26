/**
 * Spike del navegador de primer nivel: Keel lanza Chromium, el agente lo maneja con
 * @playwright/mcp por CDP, y Keel mira la misma página en vivo con Page.startScreencast.
 *
 * Mide: si el observador ve la página que abre el MCP, cuadros por segundo y su tamaño,
 * cuánto tarda en llegar el primer cuadro tras una acción, latencia de cada tool y el
 * tamaño de lo que el MCP le devuelve al agente (eso son tokens).
 *
 *   bun spikes/browser-live/src/probe.ts [--quality 60] [--max-width 1280]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { chromium } from "playwright-core"

const here = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const quality = arg("--quality", 60)
const maxWidth = arg("--max-width", 1280)

// Una app mínima: un botón que cambia el texto tras 300 ms y un formulario.
const app = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      `<!doctype html><title>Casa de prueba</title><h1 id=t>Hola</h1>
       <button onclick="setTimeout(()=>{t.textContent='Guardado';document.body.style.background='#cfe'},300)">Guardar</button>
       <label>Nombre <input name=n></label>
       <ul>${Array.from({ length: 40 }, (_, i) => `<li>Fila ${i}</li>`).join("")}</ul>`,
      { headers: { "content-type": "text/html" } },
    ),
})

// Keel es dueño del proceso del navegador: perfil temporal y puerto de depuración local.
const profile = mkdtempSync(join(tmpdir(), "keel-browser-"))
const t0 = performance.now()
const proc = Bun.spawn(
  [
    chromium.executablePath(),
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    // Sin esto Chromium pide el llavero del sistema; bloqueado (WSL), la página nunca carga.
    // Y el navegador del agente no tiene por qué tocar el llavero del humano.
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stderr: "pipe", stdout: "ignore" },
)
const endpoint = await new Promise<string>((resolve, reject) => {
  const dec = new TextDecoder()
  let buf = ""
  const reader = proc.stderr.getReader()
  const pump = (): void => {
    reader.read().then(({ value, done }) => {
      if (done) return reject(new Error(`chromium salió sin endpoint:\n${buf}`))
      buf += dec.decode(value)
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (m?.[1]) resolve(new URL(m[1]).origin.replace("ws:", "http:"))
      else pump()
    }, reject)
  }
  pump()
})
const launchMs = performance.now() - t0

// El observador de Keel: otra conexión CDP a la misma instancia.
const observer = await chromium.connectOverCDP(endpoint)
const frames: { at: number; bytes: number; url: string }[] = []
const watched = new Set<unknown>()
async function watch(page: import("playwright-core").Page) {
  if (process.env.SPIKE_NO_SCREENCAST || watched.has(page)) return
  watched.add(page)
  const cdp = await page.context().newCDPSession(page)
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
    frames.push({ at: performance.now(), bytes: (f.data.length * 3) / 4, url: page.url() })
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth,
    maxHeight: 800,
    everyNthFrame: 1,
  })
}
for (const ctx of observer.contexts()) {
  for (const p of ctx.pages()) await watch(p)
  ctx.on("page", (p) => void watch(p))
}

// El agente: @playwright/mcp por stdio, conectado al navegador de Keel.
const transport = new StdioClientTransport({
  command: "node",
  args: [
    join(here, "../node_modules/@playwright/mcp/cli.js"),
    "--cdp-endpoint",
    endpoint,
    "--image-responses",
    "omit",
  ],
  // El stderr del MCP sólo se ve al depurar.
  stderr: process.env.SPIKE_DEBUG ? "inherit" : "ignore",
})
const mcp = new Client({ name: "keel-spike", version: "0.0.0" })
await mcp.connect(transport)
const { tools } = await mcp.listTools()

type Step = { tool: string; ms: number; response_chars: number; first_frame_ms: number | null }
const steps: Step[] = []
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const before = frames.length
  const s = performance.now()
  const r = (await mcp.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[]
  }
  const end = performance.now()
  const text = r.content.map((c) => c.text ?? `[${c.type}]`).join("\n")
  if (process.env.SPIKE_DEBUG) console.error(`--- ${name}\n${text.slice(0, 900)}`)
  // Damos 1.5 s para ver si la acción produce un cuadro nuevo.
  await Bun.sleep(1500)
  const next = frames.slice(before).find((f) => f.at >= s)
  steps.push({
    tool: name,
    ms: Math.round(end - s),
    response_chars: text.length,
    first_frame_ms: next ? Math.round(next.at - s) : null,
  })
  return text
}

const startFrames = performance.now()
await call("browser_navigate", { url: `http://127.0.0.1:${app.port}/` })
// La página nueva que abrió el MCP: ¿la ve el observador?
for (const ctx of observer.contexts()) for (const p of ctx.pages()) await watch(p)
const snap = await call("browser_snapshot", {})
const ref = snap.match(/button "Guardar" \[ref=(e\d+)\]/)?.[1]
await call("browser_click", { element: "botón Guardar", target: ref })
const input = (await call("browser_snapshot", {})).match(/textbox "Nombre" \[ref=(e\d+)\]/)?.[1]
await call("browser_type", { element: "campo Nombre", target: input, text: "Ana Pérez" })
const shotDir = join(here, "../captures")
mkdirSync(shotDir, { recursive: true })
await call("browser_take_screenshot", { filename: join(shotDir, "agente.png") })
// Reposo: ¿cuántos cuadros manda Chromium cuando nada cambia?
const idleFrom = frames.length
await Bun.sleep(3000)
const idleFrames = frames.length - idleFrom
const totalS = (performance.now() - startFrames) / 1000

const bytes = frames.map((f) => f.bytes).sort((a, b) => a - b)
const result = {
  measured_at: new Date().toISOString(),
  chromium: observer.version(),
  playwright_mcp: "0.0.83",
  screencast: { format: "jpeg", quality, maxWidth },
  launch_ms: Math.round(launchMs),
  mcp_tools: tools.length,
  observer_saw_agent_page: frames.some((f) => f.url.startsWith(`http://127.0.0.1:${app.port}`)),
  frames: frames.length,
  fps_avg: Number((frames.length / totalS).toFixed(2)),
  idle_frames_3s: idleFrames,
  frame_kb_p50: Math.round((bytes[Math.floor(bytes.length / 2)] ?? 0) / 1024),
  frame_kb_max: Math.round((bytes.at(-1) ?? 0) / 1024),
  total_kb: Math.round(bytes.reduce((a, b) => a + b, 0) / 1024),
  steps,
}
console.log(JSON.stringify(result, null, 2))
writeFileSync(join(shotDir, `probe-q${quality}-w${maxWidth}.json`), JSON.stringify(result, null, 2))

await mcp.close()
await observer.close()
proc.kill()
await proc.exited
app.stop(true)
rmSync(profile, { recursive: true, force: true })
