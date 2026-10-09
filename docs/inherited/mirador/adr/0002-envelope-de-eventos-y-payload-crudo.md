# ADR-002: Envelope canónico de eventos y persistencia íntegra del payload crudo

- **Estado:** Aceptado
- **Fecha:** 2026-08-20
- **Relacionados:** ADR-001 (adaptadores), ADR-003 (correlación)

## Contexto

El set de hook events de Claude Code es grande (del orden de 30) y está en expansión
activa. La documentación oficial advierte explícitamente que no se asuma la existencia
de un evento con base en memoria, porque el set cambia.

Si normalizamos agresivamente al ingerir — una tabla por tipo de evento, columnas
tipadas para cada campo — cada release nos rompe la ingestión. Peor: los campos que no
supimos mapear se pierden para siempre, y no hay forma de recuperarlos porque la sesión
ya pasó.

## Decisión

**Envelope delgado y estable + payload crudo íntegro en `jsonb`. Se normaliza en lectura,
nunca en escritura.**

### El envelope

```ts
type AgentEvent = {
  // identidad
  id: string;              // ULID generado por el colector, ordenable en el tiempo
  received_at: string;     // ISO, reloj del colector — autoridad de orden
  occurred_at: string|null;// ISO, reloj de la fuente si lo da — puede venir sesgado

  // procedencia (ADR-001)
  source: 'hook' | 'jsonl' | 'otel' | 'sdk';
  fidelity: 'full' | 'partial';
  adapter_version: string;

  // correlación (ADR-003 — el detalle vive ahí)
  run_id: string;
  session_id: string;
  agent_id: string;
  parent_agent_id: string | null;
  tool_use_id: string | null;

  // clasificación mínima
  kind: string;            // 'PreToolUse', 'SubagentStop', ... string libre, NO enum
  tool_name: string | null;

  // el dato
  raw: unknown;            // el JSON completo del stdin del hook, sin tocar
};
```

Reglas duras:

1. **`kind` es `string`, no un enum de TypeScript ni un `CHECK` en Postgres.** Un evento
   desconocido se ingiere igual y aparece en la UI como fila genérica expandible. Nunca
   se rechaza un evento por no reconocerlo.
2. **`raw` se guarda completo y sin modificar.** Nada de borrar campos "que no usamos".
   Es el único registro que tendremos de esa sesión.
3. **Los campos del envelope se *derivan* de `raw`, no lo reemplazan.** Si la derivación
   falla, el envelope lleva `null` y el evento se ingiere de todos modos, marcado.
4. **Truncado explícito.** Un `PostToolUse` con un result set grande puede pesar mucho.
   Si `raw` excede el umbral (default 256 KB), se guarda en blob store y `raw` conserva
   un preview + puntero. La UI debe distinguir "no hay dato" de "el dato está afuera".
   Nunca se trunca en silencio.

### El store

Postgres, una sola tabla `events` con `raw jsonb`, índice GIN sobre `raw` y B-tree sobre
`(run_id, received_at)` y `(session_id, agent_id)`. Las vistas de la UI son proyecciones
materializadas o queries directas — nunca es la tabla de eventos la que cambia de forma.

Append-only. Los eventos no se editan ni se borran; las correcciones son eventos nuevos.

## Consecuencias

**Positivas**
- Un release de Claude Code que agrega eventos nos degrada a "fila genérica", no a caída.
- Podemos reprocesar históricos cuando entendamos mejor un evento: el dato sigue ahí.
- El backfill desde JSONL (fase 5) entra por la misma puerta sin esquema aparte.

**Negativas**
- Consumo de disco notablemente mayor que un esquema normalizado. Aceptado: es una
  herramienta local/de equipo, no un sistema de producción de alto volumen. Se mitiga con
  retención por `run_id` y el umbral de blob.
- Las queries analíticas sobre `jsonb` son más lentas y más incómodas de escribir. Se
  mitiga con vistas materializadas para los pocos agregados que importen (costo, latencia
  por tool, conteo por agente).
- Requiere disciplina: la presión de "nomás agrego una columnita" va a aparecer. La regla
  es que el envelope sólo crece cuando un campo es necesario para **correlacionar o
  filtrar**, nunca para mostrar.

## Alternativas consideradas

- **Esquema normalizado por tipo de evento.** Rechazada por el ritmo de cambio del set de
  eventos, que es el argumento central de este ADR.
- **Event store dedicado (EventStoreDB, NATS JetStream).** Rechazada por sobrecosto
  operativo para un despliegue local. `jsonb` en Postgres cubre el caso con lo que ya
  tenemos corriendo.
- **SQLite local-first.** Considerada seriamente y es la mejor opción si el producto se
  queda mono-usuario. Rechazada porque el camino a "el equipo ve las corridas de todos"
  requeriría migrar, y `jsonb` + GIN es mejor herramienta para este acceso que JSON1.
  Revisar esta decisión si la instalación local con cero dependencias se vuelve requisito.
