# Spike: el navegador del agente, en vivo en Keel (ADR-0030)

Mide si Keel puede ser dueño del navegador y mirarlo en vivo mientras el agente
lo maneja con `@playwright/mcp`:

- Keel lanza Chromium con un perfil temporal y un puerto de depuración local.
- El agente se conecta con `@playwright/mcp --cdp-endpoint`.
- Keel abre una segunda conexión CDP y pide `Page.startScreencast`.

## Correr

```bash
bun install
bun spikes/browser-live/src/probe.ts                 # JPEG calidad 60, 1280 de ancho
bun spikes/browser-live/src/probe.ts --quality 40
SPIKE_DEBUG=1 bun spikes/browser-live/src/probe.ts   # imprime lo que el MCP le devuelve al agente
```

No gasta turnos de ningún proveedor: un cliente MCP hace de agente. Usa el
Chromium de Playwright (`bunx playwright install chromium`). Escribe en
`captures/` (gitignored) el JSON de la medición y la captura que toma el agente.

## Resultados (2026-10-26, WSL2, Chromium 156.0.8078.4, `@playwright/mcp` 0.0.83)

| Medida                                           | Calidad 60     | Calidad 40     |
| ------------------------------------------------ | -------------- | -------------- |
| Lanzar Chromium hasta tener endpoint             | 406 ms         | 445 ms         |
| El observador ve la página que abre el agente    | sí             | sí             |
| Primer cuadro tras `browser_navigate`            | 400 ms         | 349 ms         |
| Primer cuadro tras `browser_click`               | 255 ms         | 236 ms         |
| Primer cuadro tras `browser_type`                | 137 ms         | 123 ms         |
| Tamaño de un cuadro (1280×800, JPEG)             | 22 KB          | 18 KB          |
| Cuadros en toda la prueba (≈14 s)                | 21 (1.5 por s) | 22 (1.6 por s) |
| Cuadros en 3 s de reposo con un cursor visible   | 6              | 6              |
| Respuesta de `browser_snapshot` (página chica)   | 1634 car.      | 1634 car.      |
| Latencia de `browser_click` (espera a asentarse) | 757 ms         | 738 ms         |

Lo que se lee de ahí:

- Chromium sólo manda cuadros cuando la página cambia. En reposo, un cursor que
  parpadea da unos 2 por segundo.
- A unos 20 KB por cuadro, el vivo cabe en el socket de ADR-0005 sin guardarse:
  la mayor parte del tiempo son menos de 50 KB por segundo.
- El agente trabaja con el árbol de accesibilidad (`browser_snapshot`), no con
  imágenes. Con `--image-responses omit` las capturas no le gastan tokens; van a
  disco y Keel las guarda como evidencia.
- `@playwright/mcp` 0.0.83 expone 25 tools. `browser_run_code_unsafe` y
  `browser_evaluate` corren código arbitrario en la página.

## Hallazgo: Chromium se cuelga con el llavero bloqueado

Sin `--password-store=basic`, Chromium pide el llavero del sistema (Secret
Service). En WSL el llavero queda bloqueado, así que ninguna página termina de
cargar: `page.goto` vence siempre, también con Playwright solo, sin el MCP.
`chrome --headless=new --dump-dom` se cuelga igual, y con
`--password-store=basic` responde al instante.

Keel lanza el navegador del agente con `--password-store=basic` y
`--use-mock-keychain`. Además, ese navegador no tiene por qué tocar el llavero
del humano.
