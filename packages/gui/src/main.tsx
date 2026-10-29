// Primero las capas: el orden en que aparecen decide cuál gana (ADR-0034 §3).
import "./index.css"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/jetbrains-mono/400.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { ToastProvider, ToastViewport, TooltipProvider } from "./ui/index.js"

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <TooltipProvider>
          <App />
          <ToastViewport />
        </TooltipProvider>
      </ToastProvider>
    </StrictMode>,
  )
