import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2022" },
  // Importado bajo demanda («Abrir carpeta…»): sin esto vite lo descubre en caliente,
  // reoptimiza y recarga la página a mitad de uso.
  optimizeDeps: { include: ["@tauri-apps/plugin-dialog"] },
})
