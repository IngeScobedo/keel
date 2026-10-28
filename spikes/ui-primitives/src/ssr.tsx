// Proceso aparte: vite deja NODE_ENV=production y Bun compila JSX con jsxDEV.
import { renderToString } from "react-dom/server"

const name = process.argv[2] as string
const mod = (await import(`./${name}.tsx`)) as { app: Parameters<typeof renderToString>[0] }
try {
  const html = renderToString(mod.app)
  console.log(`ok (${html.length} B de HTML)`)
} catch (e) {
  console.log(e instanceof Error ? e.message.slice(0, 80) : String(e))
}
