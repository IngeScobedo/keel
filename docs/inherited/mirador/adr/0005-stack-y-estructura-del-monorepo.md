# ADR-005: Stack técnico y estructura del monorepo

> **Parcialmente superseded por
> [ADR-007](./0007-runtime-bun-en-todo-el-repo.md)** (2026-08-20): la fila
> «Runtime» de la tabla de stack, la elección «npm workspaces» y la alternativa
> «Bun / Deno como runtime» ya no aplican. El resto de este ADR sigue vigente.
> El contenido original se conserva sin editar.

- **Estado:** Aceptado — parcialmente superseded por ADR-007 (runtime y
  workspaces)
- **Fecha:** 2026-08-20
- **Relacionados:** ADR-001, ADR-002, ADR-006

## Contexto

Hay que elegir herramientas para la primera iteración sabiendo que la fase
runtime (ADR-001) va a agregar un paquete más y que el proxy MCP tiene que poder
publicarse y usarse fuera de este repo.

## Decisión

### Estructura de paquetes

```
packages/
  core/          # envelope, esquemas Zod, lógica de correlación. Cero deps de I/O.
  collector/     # Fastify: ingesta HTTP, SSE, repositorio Postgres, gates
  hook-bridge/   # binario que se registra en settings.json; lee stdin, spool, POST
  mcp-proxy/     # publicable independiente; passthrough + instrumentación
  web/           # dashboard
  runtime/       # (fase 7) adaptador del Agent SDK. No existe en v1.
```

Regla de dependencias: `core` no depende de nadie. Todos dependen de `core`.
`collector` **no** depende de `runtime` ni de `mcp-proxy`. `mcp-proxy` depende
sólo de `core`, y de la parte de `core` que es puro tipo/esquema, para poder
publicarse sin arrastrar el resto.

### Monorepo: **npm workspaces solo, sin Nx — con una excepción**

- Si esto arranca como **repo nuevo**: npm workspaces + TypeScript project
  references, y nada más. Seis paquetes de este tamaño no justifican el task
  graph, el caching ni `nx affected`. Esa maquinaria empieza a pagarse cuando el
  build local pasa de ~10s o cuando el CI duele, y ninguna de las dos cosas va a
  pasar en las primeras semanas. Agregar Nx después a un workspace de npm es
  trivial; quitarlo no.
- Si esto vive **dentro de un monorepo Nx que ya existe**: quédate en Nx. La
  consistencia con lo que ya corre vale más que la simplicidad marginal, y la
  fricción de tener dos sistemas de build en la cabeza es peor que la de tener
  uno de más.

En cualquiera de los dos casos, `mcp-proxy` se estructura como si fuera a vivir
fuera del repo: build propio, `package.json` publicable, sin imports relativos
hacia afuera de su carpeta. Es lo único aquí que tiene vida independiente.

### Stack

| Capa        | Elección                                       | Razón                                                                                                       |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lenguaje    | TypeScript, `strict`, ESM                      | El SDK de MCP y el Agent SDK son TS de primera clase                                                        |
| Runtime     | Node LTS                                       | Compatibilidad con el ecosistema de MCP                                                                     |
| Validación  | Zod                                            | El envelope necesita parseo en el borde; `safeParse` nunca lanza en ingesta                                 |
| Ingesta     | Fastify                                        | Ya en uso; el hot path es un `POST` que valida y encola                                                     |
| Store       | Postgres + `jsonb` + GIN                       | ADR-002. Ya está en el stack                                                                                |
| Migraciones | Una sola herramienta, elegida y documentada    | Da igual cuál; importa que sea una                                                                          |
| Push a UI   | **SSE**, no WebSocket                          | El stream es unidireccional; las acciones (aprobar/denegar) van por `POST`. Menos estado, reconexión gratis |
| UI          | React + la librería de componentes que ya usen | No es el diferenciador; no inventar aquí                                                                    |
| Tests       | Fixtures reales de la Fase 1                   | Los tests de correlación corren contra sesiones capturadas, no contra mocks                                 |

### Sobre SSE vs WebSocket

Vale la pena explicitarlo porque el instinto es WS. El flujo de datos es
servidor→cliente casi puro: eventos que llegan. Las únicas acciones
cliente→servidor son aprobar/denegar un gate y filtrar, y ambas son
perfectamente un `POST`. SSE trae reconexión automática con `Last-Event-ID`, que
es exactamente lo que quieres cuando cierras la laptop a media corrida. Si el
modo runtime interactivo (mandar prompts desde la UI) llega a necesitar
bidireccionalidad real, ahí se reevalúa — pero no antes.

## Consecuencias

**Positivas**

- Nada del stack es nuevo salvo el SDK de MCP; la curva se concentra donde está
  el valor.
- `mcp-proxy` aislado permite publicarlo aunque el resto del producto no
  despegue.
- SSE elimina una clase entera de bugs de reconexión.

**Negativas**

- Postgres implica que la herramienta no es "descarga y corre". Aceptado por
  ahora; revisar si la distribución se vuelve prioridad (ver alternativa en
  ADR-002).
- Sin Nx, cuando el repo crezca va a haber un momento incómodo de scripts de
  build. Es deuda consciente y barata de pagar.

## Alternativas consideradas

- **Nx desde el inicio en repo nuevo.** Rechazada: resuelve un problema de
  escala que no tenemos, y su costo se paga los primeros días, que son los de
  mayor energía.
- **Bun / Deno como runtime.** Rechazada por compatibilidad con el ecosistema
  MCP, que es la dependencia menos negociable del proyecto.
- **WebSocket.** Rechazada arriba; reevaluable en fase runtime.
- **Un solo paquete monolítico.** Rechazada: rompe la publicabilidad del proxy y
  la frontera de adaptadores del ADR-001, que es justo lo que hace barato el
  modo runtime.
