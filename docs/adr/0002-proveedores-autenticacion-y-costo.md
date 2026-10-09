# ADR-0002: Proveedores vía SDK oficial, cero manejo de credenciales y costo etiquetado

- **Estado:** Propuesto
- **Fecha:** 2026-10-08
- **Criticidad:** Máxima — es lo que mantiene a Keel y a sus usuarios dentro de
  los términos
- **Relacionados:** ADR-0001 (herencia), ADR-0004 de Mirador (postura de
  seguridad), SDD 02 §8
- **Evidencia:** docs oficiales leídos el 2026-10-08:
  `code.claude.com/docs/en/legal-and-compliance`, `/agent-sdk/overview`,
  `/agent-sdk/quickstart`, `/authentication`, `/agent-sdk/cost-tracking`,
  `/agent-sdk/typescript`, `/agent-sdk/hooks`;
  `anthropic.com/legal/consumer-terms` y `/legal/aup`.

## Contexto

Keel ejecuta agentes con el Claude Agent SDK y el Codex SDK. Es una herramienta
open source, gratuita, que cada persona descarga y corre en su máquina con su
propia cuenta. El usuario de Keel hoy trabaja con una suscripción de Claude
Code, no con API key.

Lo que dicen los docs de Anthropic, textual:

- Prohibido: «Anthropic does not permit third-party developers to offer
  Claude.ai login into their own applications, or to route requests through
  Free, Pro, or Max plan credentials on behalf of their users. Moreover,
  developers may not collect, store, or intermediate Claude.ai credentials or
  session tokens.» Las páginas del SDK añaden «unless previously approved».
- Permitido: nada impide «an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription». Los límites de Pro y Max
  «assume ordinary, individual usage of Claude Code and the Agent SDK».
- Mecánica: la precedencia de autenticación de Claude Code, que incluye el OAuth
  de `/login`, aplica «to the CLI and the surfaces that wrap it, including the
  Agent SDK». El SDK bundlea su propio binario, pero
  `pathToClaudeCodeExecutable` permite apuntar al del usuario.
- No documentado: ninguna excepción para herramientas open source o locales. Los
  Consumer Terms restringen el acceso automatizado salvo con API key o permiso
  explícito, y los docs no reconcilian eso con un tercero local. Para dudas,
  mandan a ventas.
- Costo: `total_cost_usd` y `costUSD` son «client-side estimates, not
  authoritative billing data», calculados con una tabla de precios bundleada; no
  se dice qué reportan bajo suscripción.

Keel no está prohibido por el texto ni bendecido por él. Está en «ordinary,
individual usage» si, y sólo si, se comporta como una persona usando Claude Code
sin modificar.

## Decisión

### 1. El modo de autenticación es una capacidad declarada por perfil

El adaptador de cada proveedor declara qué modos soporta y el perfil de proyecto
elige uno: `subscription_session`, `api_key`, `bedrock` o `vertex`. El daemon no
asume ninguno y **no hay fallback silencioso** entre modos. Los dos primeros se
describen abajo; `bedrock` y `vertex` son `api_key` con las credenciales del
proveedor cloud, cuando el SDK los soporte.

Lo que dice la documentación oficial, y que aplica aunque Keel no toque la
autenticación y aunque se dirija el `claude` del usuario por subproceso en vez
de por el SDK: «Unless previously approved, Anthropic does not allow third party
developers to offer claude.ai login or rate limits for their products, including
agents built on the Claude Agent SDK»
(`code.claude.com/docs/en/agent-sdk/overview`). Pedir esa confirmación o
aprobación es tarea del humano; mientras llega, el modo `subscription_session`
existe en el diseño y se usa sólo para uso personal del propio desarrollador.
Hay una fuente secundaria no oficial que menciona un crédito mensual separado
para el Agent SDK en planes de suscripción desde junio de 2026: **no se cita
como hecho**; queda pendiente de verificar en documentación oficial.

### 1b. Los dos modos locales

| Modo                       | Cómo                                                                                                                                                                                                      | Para quién                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **`api_key`**              | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` del entorno o del vault de Keel (referencia, nunca valor en el store). Bedrock/Vertex cuando el SDK lo soporte.                                                    | El único modo que los docs sancionan para «productos». Default para equipos y CI. |
| **`subscription_session`** | Keel invoca el **binario de Claude Code instalado por el usuario** (`pathToClaudeCodeExecutable`) y deja que ese binario use la sesión que ya tenga. Para Codex, el CLI `codex` del usuario con su login. | Una persona en su máquina con su cuenta.                                          |

El modo se declara por perfil de proyecto, es visible en la UI (chip de runtime)
y **no hay fallback silencioso** de uno a otro. Si el modo
`subscription_session` no encuentra sesión, Keel lo dice y ofrece abrir un pane
de terminal con `claude` para que el usuario haga `/login` ahí.

### 2. Cuatro reglas que convierten «ordinary, individual usage» en código verificable

1. **Keel no tiene login.** No implementa OAuth. No lee, copia, cachea ni
   sincroniza `~/.claude.json`, `~/.codex/auth.json` ni ningún archivo de
   credenciales. No hace proxy de requests. Un test de lint
   (`noRestrictedImports` + grep en CI) falla si aparece una ruta a esos
   archivos en el código.
2. **Keel no bundlea ni modifica el binario de Claude Code.** Detecta el
   instalado; si falta, explica cómo instalarlo con el instalador oficial. El
   binario que trae el SDK sólo se usa en modo `api_key` si el usuario no tiene
   `claude` instalado.
3. **Defaults que parecen una persona trabajando.** Concurrencia de workers baja
   por defecto, el complexity gate del SDD (C1–C2 un worker), un presupuesto por
   tarea y por día. Subir los límites es una decisión explícita del usuario con
   el efecto visible.
4. **README con no-afiliación** y con la frase de que el uso queda sujeto a los
   términos de la cuenta de cada usuario.

### 3. Costo: nunca sonar a factura

- `runs.cost_kind` (SDD 03) toma `observed` sólo cuando el proveedor devuelve un
  importe autoritativo (hoy: ninguno de los dos SDKs). Bajo `api_key` con
  `total_cost_usd` del SDK es `estimated`; bajo `subscription_session` es
  `estimated` si el SDK devuelve un número y `unknown` si devuelve cero o nada.
  **El spike decide cuál.**
- Toda cifra en USD en la UI lleva su `cost_kind` al lado («$1.84 estimado»,
  «cuota»). La barra de estado del canvas («$12.40 today») se etiqueta igual.
- Tokens (`input`, `output`, `cache_read`) se muestran siempre que existan: son
  el dato honesto.

### 4. Identidad de agentes: el SDK es un canal más, con precedencia máxima

El SDK entrega `agent_id` y `parent_tool_use_id` en mensajes y
`agent_id`/`agent_type` en hooks. Se añade el canal **0: `sdk`** por encima de
los tres de ADR-0010 de Mirador. Codex no expone subagentes nativos: ahí Keel
programa workers independientes y la identidad es propia (SDD 02 §8, «Subagent
Synthesizer»). `parent_source` se conserva para que la UI distinga certeza de
heurística.

### 5. Preguntar no cuesta nada

Antes de la primera release pública se escribe a Anthropic (vía el contacto que
los docs indican) describiendo Keel como herramienta open source gratuita sin
login propio. La respuesta, si llega, se adjunta a este ADR como nota con fecha.
No se espera a la respuesta para desarrollar.

## Evidencia del spike (2026-10-08, `spikes/sdk-capabilities/FINDINGS.md`)

- Modo `subscription_session` funciona mecánicamente sin que Keel toque
  credenciales: `init.apiKeySource: "none"` y la query completa con la sesión de
  `/login` del binario del usuario.
- Bajo esa sesión el SDK **sí** devuelve `total_cost_usd` (estimación a precio
  de lista, `costBasis: "list"`). Decisión para §3: `cost_kind = estimated`,
  nunca `observed`.
- El SDK emite `rate_limit_event` con utilización por ventana (`five_hour`,
  `seven_day`) y `resetsAt`: es el dato de «cuota» para la UI en modo
  `subscription_session`.
- Codex: el SDK usa el login de ChatGPT del CLI; la corrida falló por límite de
  uso de la cuenta, no por auth. Términos de OpenAI siguen sin verificar.

## Consecuencias

**Positivas**

- La postura queda en código, no en intenciones: cuatro reglas con test.
- Si la política cambia, el modo `api_key` ya existe y el cambio es de
  configuración.
- El usuario de Keel nunca entrega credenciales a Keel. Es también la mejor
  postura de seguridad.

**Negativas**

- En modo `subscription_session` Keel depende de un binario que no controla
  (versión, flags, comportamiento). Mitigación: matriz de capacidades por
  versión (SDD 02 §8) y `claude_code_version` del `init` guardado en cada run.
- El costo en modo `subscription_session` es probablemente `unknown`: la UI de
  presupuesto se degrada a tokens y tiempo. Aceptado y ya contemplado en el SDD.
- Codex con suscripción de ChatGPT no está verificado. Hasta verificarlo, Codex
  sólo en `api_key`.

## Alternativas consideradas

- **Extraer el token OAuth de `~/.claude.json` y hablar con la API
  directamente** (borrador `docs/02` de `cc-ui`). Rechazada: es exactamente
  «collect, store, or intermediate Claude.ai credentials».
- **Sólo API key.** Rechazada como único modo: deja fuera al propio autor y a la
  mayoría de usuarios individuales, que ya pagan una suscripción.
- **Bundlear Claude Code dentro del ejecutable de Keel.** Rechazada: los docs
  exigen Commercial Terms para «preinstall or run Claude Code in your products»
  y Keel no quiere ser eso.
