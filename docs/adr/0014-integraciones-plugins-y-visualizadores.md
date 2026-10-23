# ADR-0014: Integraciones: tres niveles, plugins fuera de proceso y visualizadores

- **Estado:** Propuesto
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0007 (kit, extraer con el segundo consumidor), ADR-0009
  (puente MCP), ADR-0011 (eventos semánticos, `keel mcp proxy`), ADR-0012
  (artefactos), ADR-0013, ADR-0015

## Contexto

Keel es de código abierto. El humano quiere que alguien pueda dar soporte de
primer nivel a una herramienta (Playwright, PostgreSQL, una de testing) sin
conocer el scheduler ni el store. Por ejemplo, que un MCP de PostgreSQL se vea
como tarjetas con la consulta y sus filas, o que las capturas de Playwright
queden como evidencia de un cambio.

Sobre MCP Apps, consultado en fuentes secundarias el 2026-10-22: es la extensión
oficial de MCP para interfaces interactivas (SEP-1865, identificador
`io.modelcontextprotocol/ui`). Un servidor publica HTML en recursos `ui://` que
el host muestra en un iframe aislado. La comunicación es JSON-RPC por
`postMessage` y la CSP es restrictiva por defecto. Las fuentes no coinciden en
algunas claves, así que se lee la especificación vigente antes de implementar.

## Decisión

1. **Tres niveles de integración.**
   - **Nivel 1, genérico:** cualquier tool o servidor MCP. Se ven nombre,
     argumentos, estado, duración y resultado. Si el resultado es tabular, se
     muestra como tabla y se ofrece una gráfica sin que el agente escriba
     código.
   - **Nivel 2, intérprete semántico:** un plugin reconoce la operación y
     produce eventos semánticos (ADR-0011) con sus visualizadores.
   - **Nivel 3, nativo:** Keel o un servidor MCP que conoce a Keel emite el
     evento semántico directamente, con acciones autorizadas y, si quiere, su
     propia interfaz.
2. **Un plugin es un manifiesto declarativo** (`keel-plugin.json`), con:
   - `id`, versión y rango de la API de Keel.
   - Qué reconoce: patrones de servidor o tool MCP, o tipos de evento.
   - Los `kind` semánticos que emite, con su esquema.
   - Sus visualizadores y los permisos que pide: `events:emit`,
     `artifacts:create`, `evidence:attach`.

   No hay permisos para secretos, la base interna ni el daemon.

3. **Los intérpretes corren fuera del daemon.** Uno por plugin, en su propio
   proceso, por JSON-RPC sobre stdio.
   - El daemon le pasa los eventos que coinciden y valida lo que devuelve contra
     el esquema y los permisos declarados.
   - Hay tiempo límite. Si el plugin cae, sólo se pierde su interpretación.
   - Un intérprete es una función pura de los eventos, sin E/S, para que la
     reconstrucción de ADR-0011 sea posible.
   - Limitar sistema de archivos y red por sistema operativo se medirá antes de
     prometerlo.
4. **Visualizadores en dos formas.**
   - **Declarativos (primero):** composición de primitivas del UI kit de Keel
     (tabla, gráfica Vega-Lite, código, diff, clave-valor, línea de tiempo) a
     partir de los datos del evento. No ejecutan código y la TUI los muestra
     como texto.
   - **MCP Apps (después):** para servidores que las publiquen, en un iframe
     aislado. Las llamadas al host se validan y pasan por los mismos permisos.
     Se negocia la capacidad y se implementa contra la especificación vigente.
5. **Nadie es dueño de los datos más que Keel.** Los visualizadores leen eventos
   y artefactos del daemon. Si se desinstala un plugin, su evidencia sigue y se
   ve con el visualizador genérico.
6. **Instalación explícita.** El humano instala un plugin con versión y hash
   fijos, sin actualizarse solo. Un registro comunitario queda para cuando haya
   plugins de terceros.
7. **Paquetes según ADR-0007.** Las primeras integraciones (git, la tabla
   genérica y PostgreSQL) viven en el daemon y la GUI. `@keel/plugin-sdk`
   (tipos, esquema del manifiesto y arnés de pruebas con fixtures) se publica
   cuando exista el primer plugin externo.

## Criterios de aceptación

- Un resultado tabular de un servidor MCP cualquiera se ve como tabla con la
  opción de graficar, sin plugin.
- Un plugin de ejemplo convierte un fixture de llamada MCP en un evento
  semántico, y un evento que viola su esquema se rechaza.
- Matar el proceso del plugin no afecta al daemon ni a otros plugins.
- Desinstalar el plugin no borra evidencia.

## Consecuencias

- Hace falta un host de plugins en el daemon y un registro de visualizadores en
  la GUI y la TUI.
- El UI kit de primitivas declarativas pasa a ser contrato público versionado.
- El soporte de MCP Apps en la GUI (Tauri) necesita su propia prueba de
  aislamiento.

## Alternativas consideradas

- **Plugins dentro del proceso del daemon.** Un plugin con fallas o malicioso
  tendría acceso a todo.
- **Sólo MCP Apps.** No todos los servidores las publican, y Keel debe verse
  bien sin ellas.
- **Sólo el visor genérico.** No reconoce operaciones de dominio ni produce
  evidencia útil.
