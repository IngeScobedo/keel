# ADR-0036: El razonador de intake es código determinista

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0035 (el lote nace de un mensaje): este ADR decide cómo se parte el
    mensaje.
  - ADR-0021 (validación determinista de documentos): el check de listo reusa la
    del brief.
  - ADR-0040 (fuentes): un documento largo pasa por el mismo esquema.
  - SDD `05-chat-to-orchestrate.md`, §Razonador determinista de intake.

## Contexto

El research propone que lo mecánico del intake lo haga código, no un agente:
segmentar, anclar al repo, clasificar, ordenar y preguntar lo que falta. Es la
misma línea de ADR-0021 (lo que un script comprueba no gasta tokens) y de
ADR-0032 (la clase de un comando la decide Keel).

Lo que no hay todavía: los mensajes reales del caso de Casa Matte para medir. El
research sólo trae su resumen.

## Decisión

### 1. Un módulo puro en `@keel/core`

`intake.ts`, sin I/O, con esta salida:

```ts
type Intent = {
  key: string; // T1, T2… como el documento `tasks`
  text: string;
  kind:
    | "copy"
    | "ui-change"
    | "bugfix"
    | "feature"
    | "refactor"
    | "design-proposal"
    | "research"
    | "docs"
    | "release"
    | "chore"
    | "correction";
  confidence: number; // 0..1
  ordering: "now" | { after: string[] } | "end-of-batch" | "deferred";
  ready: {
    goal: boolean;
    scope: boolean;
    acceptance: boolean;
    questions: Question[];
  };
  anchors: string[]; // rutas o globs del repo
  provenance: { message_id: string; span: [number, number] };
};
```

El razonador recibe el mensaje, un índice del repo (rutas, componentes,
glosario) y el perfil de calidad. **Nunca ejecuta nada:** su salida es la
tarjeta de plan (ADR-0035).

### 2. El pipeline

1. **Segmentar:** por listas, saltos, `;` y conectores («además», «también», «y
   que»). Une fragmentos que comparten objeto.
2. **Anclar:** cada fragmento contra el índice del repo. Sin ancla, el alcance
   queda sin confirmar.
3. **Clasificar:** reglas por verbo y patrón, en español e inglés. Un empate se
   marca como ambiguo; no se adivina.
4. **Ordenar:**
   - «al final» → `end-of-batch`; «después», «lo vemos después» → `deferred`;
   - mismo ancla → mismo carril o dependencia;
   - una propuesta bloquea a lo que la implementa.
5. **Check de listo:** objetivo, alcance y criterio de aceptación. Cada hueco es
   una pregunta de plantilla, con opciones si el repo las da.
6. **Perfil de calidad:** agrega lo que el proyecto exige y nadie pidió (tests
   de textos, changelog, cierre de lote).
7. **Ratificación y corrección:** «sí a las cuatro» no es un intent nuevo, es
   ratificar (ADR-0037); «nunca», «no puedes», «sólo si» proponen una
   invariante.

### 3. Cuándo entra un LLM

Sólo si la confianza de segmentación o clasificación baja de un umbral, o si hay
más de dos preguntas por intent. El agente de intake devuelve el mismo esquema y
pasa por el mismo check de listo. **El umbral sale del spike**, no de este ADR.

### 4. Mientras escribes

El razonador corre en la GUI sobre el borrador y muestra los chips de intent
antes de enviar. Es el mismo código, importado de `@keel/core`.

## Spike antes de implementar

- Fixtures: los tres mensajes literales de la sesión de Casa Matte, más diez
  mensajes reales de Keel y de Casa Matte, todos con su resultado esperado
  escrito a mano.
- Medir:
  - aciertos de segmentación y de clase;
  - preguntas por intent;
  - tiempo por mensaje (el objetivo es que quepa mientras escribes).
- De ahí sale el umbral de escalamiento.

## Criterios de aceptación

- El mensaje 1 del caso produce los 7 intents y el cierre de lote del research.
  El mensaje 2 produce una corrección con su invariante propuesta. El mensaje 3
  ratifica cuatro decisiones y difiere una.
- Un mensaje ambiguo produce un chip punteado con «Aclarar» y su pregunta.
- Ningún intent arranca sin el gate del plan.

## Consecuencias

- El intake no gasta tokens en el camino normal y se prueba con tests de tabla.
- Las reglas hay que mantenerlas por idioma. Un falso «listo» es el error caro;
  por eso lo ambiguo pregunta.

## Alternativas consideradas

- **Que el intake sea siempre un agente.** No es determinista, cuesta en cada
  mensaje y no se puede probar con tablas.
- **Regex sueltas en el daemon.** El research pide el mismo código en la GUI
  (chips en vivo) y en el daemon: va en `@keel/core`.
