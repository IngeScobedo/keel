import { useState } from "react"
import { createRoot } from "react-dom/client"

// Lo que hay hoy: controles nativos del WebView.
function App() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      {open && (
        <dialog open>
          Hola
          <button type="button" onClick={() => setOpen(false)}>
            x
          </button>
        </dialog>
      )}
      <select defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
      <input type="checkbox" />
      <input type="checkbox" role="switch" aria-checked="false" />
      <details>
        <summary>Popover</summary>contenido
      </details>
      <span title="tooltip">?</span>
    </div>
  )
}
export const app = <App />
if (typeof document !== "undefined")
  createRoot(document.getElementById("root") as HTMLElement).render(app)
