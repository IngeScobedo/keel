# Spike: primitivas accesibles para los controles de la GUI (ADR-0034)

Construye el mismo conjunto de controles (diálogo, select, checkbox, switch,
popover, menú, pestañas y tooltip) con cada librería, sin estilos, y mide el JS
que agrega sobre React solo. También los renderiza en el servidor: si una pieza
del API no existe, React falla y se ve en la columna SSR.

```bash
bun spikes/ui-primitives/src/measure.ts
```

## Resultados (2026-10-28, vite 8, `target: es2022`, gzip nivel 9)

| Librería                       | JS min   | gzip     | gzip sobre React | Paquetes que instala | SSR |
| ------------------------------ | -------- | -------- | ---------------- | -------------------- | --- |
| React solo, controles nativos  | 214.4 KB | 66.3 KB  | —                | —                    | ok  |
| `@base-ui/react` 1.9.0         | 416.1 KB | 132.2 KB | 65.9 KB          | 6                    | ok  |
| `radix-ui` 1.8.1               | 341.4 KB | 105.9 KB | 39.6 KB          | 56                   | ok  |
| `react-aria-components` 1.22.1 | 422.4 KB | 130.7 KB | 64.4 KB          | 9                    | ok  |

- El bundle actual de la GUI pesa 2.2 MB en `dist/assets`, casi todo Vega. La
  diferencia entre librerías (26 KB gzip) no decide.
- **Piezas que trae cada una** y que la GUI va a usar:

  | Pieza                          | Base UI | Radix | React Aria |
  | ------------------------------ | ------- | ----- | ---------- |
  | Combobox (select con búsqueda) | sí      | no    | sí         |
  | Drawer                         | sí      | no    | no         |
  | Toast                          | sí      | sí    | sí (beta)  |
  | Preview card (hover)           | sí      | sí    | no         |
  | Field / Form con validación    | sí      | sí    | sí         |

- Las tres son sin estilos: el aspecto lo ponen los tokens de Keel y se ve igual
  en WebKitGTK (Linux), WebView2 (Windows) y WKWebView (macOS). El `<select>`
  nativo no: su lista desplegable la dibuja cada sistema y el CSS no la alcanza
  (`appearance: base-select` sólo existe en Chromium, o sea sólo en WebView2).
