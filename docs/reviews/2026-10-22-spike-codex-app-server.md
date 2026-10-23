# Spike del App Server de Codex · 2026-10-22

Pruebas de la sección «Spike del App Server» de ADR-0008, con el permiso del
humano para usar su cuenta de ChatGPT. Versiones: `codex-cli` 0.162.1,
`@openai/codex-sdk` 0.162.0, Linux sobre WSL2. Modelo `gpt-5.6-luna` con
esfuerzo `low`, el más chico que lista `model/list`. Probe y forma de repetirlo
en `spikes/codex-app-server/`.

## Resultado

| Prueba                | Observado                                                                                                                                                                                                                                                   | ¿Cumple el criterio?                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Turno con suscripción | `initialize` → `thread/start` → `turn/start` → `turn/completed` en 3.1 s, sin API key en el entorno. `account/updated` trae `authMode: "chatgpt"`.                                                                                                          | Sí.                                                                                           |
| Sin sesión            | Con `CODEX_HOME` vacío, `account/read` devuelve `account: null` y `requiresOpenaiAuth: true` sin gastar turnos. Si se insiste, el turno arranca, emite 5 `error` con `willRetry` y falla a los 17 s con `httpConnectionFailed { httpStatusCode: 401 }`.     | Sí, si el preflight usa `account/read` (o `codex login status`). No llega `unauthorized`.     |
| Aprobación            | `item/commandExecution/requestApproval` trae comando, `cwd` y `availableDecisions`. El servidor esperó 20 s sin timeout ni notificaciones. Con `decline` llegó `serverRequest/resolved`, el item quedó `declined` y el archivo no se creó.                  | Sí para `command`. `file_change` y `permissions`: pendientes.                                 |
| Concurrencia          | Dos app-server a la vez: pids distintos, cada uno con su hilo, cero notificaciones del hilo ajeno.                                                                                                                                                          | Sí.                                                                                           |
| Cancelación           | `turn/interrupt` cierra el turno como `interrupted` en 2 ms y sin `error`. El comando (`codex-linux-sandbox` → `bwrap` → `sleep`) seguía vivo a 1, 5 y 10 s con el app-server vivo; murió cuando el app-server salió.                                       | En parte: el estado sí; el proceso no. Hay que cerrar el app-server para matar el comando.    |
| Reinicio del daemon   | Padre muerto con SIGKILL a mitad de un comando: a los 2 s no quedaba nada del árbol (shim de Node, `codex` nativo, sandbox y `sleep`).                                                                                                                      | Sí: sin huérfanos. El run lo marca `interrupted` Keel al reconciliar.                         |
| Aislamiento (Linux)   | `workspace-write` sin aprobaciones: escribir en `$HOME` fuera del cwd da «Read-only file system»; sin red (no resuelve DNS); `connect()` a un socket Unix da `EPERM`, tanto en `$HOME` como en un `/tmp` escribible. `/tmp` y `$TMPDIR` sí son escribibles. | Sí, salvo `/tmp`. Windows y WSL con codex de Windows: pendientes (no hay `codex` en Windows). |
| Sesión caducada       | No se puede provocar sin tocar credenciales. Lo más cercano es la falta de sesión: 401 dentro de `httpConnectionFailed`.                                                                                                                                    | Pendiente.                                                                                    |
| Fixture               | Capturas crudas en `captures/` (sin redactar, fuera de git). Versionado: lista de métodos y sha256 del esquema 0.162.1 (el bundle pesa 4.4 MB).                                                                                                             | En parte: falta el fixture redactado de eventos.                                              |

### Fuera de la tabla

- **Tools del cliente.** Con `experimentalApi: true` en `initialize`,
  `thread/start` acepta `dynamicTools`. Llegó `item/tool/call` con los
  argumentos y la respuesta volvió al modelo (contestó con el texto devuelto).
  Los servidores MCP por `config` de `thread/start` no se midieron.
- **Transporte SDK.** Turno completo con `runStreamed` y sin API key: eventos
  `thread.started`, `turn.started`, `item.completed` y `turn.completed`, con
  tokens en `usage`. No expone pid. La cancelación con `signal` lanza
  `AbortError`; un segundo después seguía vivo un `sleep 40` del comando. No se
  midió cuándo terminó.
- **Errores para `RunSignals`.** Falta de sesión: `error` con
  `responseStreamDisconnected { httpStatusCode: 401 }` y `willRetry: true`, y
  cierre `failed` con `httpConnectionFailed { httpStatusCode: 401 }`.
  Denegación: turno `completed` con el item `declined`. Interrupción:
  `interrupted` sin `error`.
- **Cuota y tokens.** `thread/tokenUsage/updated` trae tokens por turno y
  acumulados. `account/rateLimits/updated` trae el porcentaje usado de las
  ventanas de 5 h y 7 días.

## Hallazgos que cambian el diseño

1. **Cancelar no es `turn/interrupt` solo.** El turno se cierra, pero el comando
   sigue corriendo. Con un app-server por run, cancelar es interrumpir y luego
   cerrar el proceso.
2. **El sandbox bloquea el socket del daemon en Linux.** `connect()` a AF_UNIX
   da `EPERM` aunque la ruta sea escribible. Es evidencia para ADR-0009 §8 en
   Linux; Windows queda sin medir.
3. **`/tmp` es escribible en `workspace-write`.** El esquema tiene
   `excludeSlashTmp` y `excludeTmpdirEnvVar` en `sandboxPolicy`; no se midieron.
4. **El `codex` del PATH es un shim de Node** que lanza el binario nativo. El
   pid que Keel lanza no es el del binario: `processes.ts` registraría `node`.
5. **El app-server carga la configuración del usuario.** Arrancó el servidor MCP
   `codex_apps` de `~/.codex/config.toml` en cada hilo. Keel debe pasar sus
   propios overrides por `config`.
6. **Existe `account/chatgptAuthTokens/refresh`**, una petición del servidor
   para que el cliente refresque tokens. Keel nunca la atiende (ADR-0002); el
   probe responde `-32601` a toda petición que no conoce.

## Costo

13 turnos, todos con `gpt-5.6-luna` y esfuerzo `low`, sobre 13 400 tokens de
entrada por turno (unos 10 000 en caché) y salidas de pocos tokens. Un turno se
perdió por una ruta de socket demasiado larga (AF_UNIX admite unos 108 bytes).
Tras las pruebas, `account/rateLimits/updated` reportaba 0 % de las ventanas de
5 h y de 7 días.

## Cómo repetirlo

Con `codex` instalado y sesión iniciada, seguir `spikes/codex-app-server/`
(`models` y `nologin` no gastan turnos). Las capturas no se versionan: contienen
rutas locales.
