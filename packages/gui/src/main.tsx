import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/jetbrains-mono/400.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import "./tokens.css"
import "./styles.css"

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
