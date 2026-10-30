# ADR-0040: Fuentes y procedencia

- **Estado:** Aceptado (2026-10-30)
- **Fecha:** 2026-10-30
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0012 (artefactos direccionados por contenido y evidencia con
    procedencia).
  - ADR-0017 (contexto para agentes y búsqueda), ADR-0025 (lo que el agente
    recibe).
  - ADR-0036 (un documento largo pasa por el razonador), ADR-0037 (las
    decisiones citan su pasaje).

## Contexto

El research pide que «lo que decidió el cliente en el Meet» sea un enlace, no un
recuerdo:

- una minuta en Word, un PDF, una transcripción, una captura o un enlace entran
  al proyecto;
- cada tarea, decisión o invariante cita el pasaje exacto del que salió.

## Decisión

### 1. Una fuente es un artefacto del proyecto, partido en pasajes

- El archivo original se guarda como artefacto (ADR-0012).
- Keel lo parte con código según su tipo:
  - documento: por encabezado y párrafo;
  - PDF: por página y bloque;
  - transcripción: por turno de hablante, con su hora;
  - imagen: completa, con sus regiones marcadas.
- Cada pasaje tiene un id estable (`S-4 §18`) y entra a la búsqueda de ADR-0017.

### 2. El contenido es dato, nunca instrucción

- Lo que dice un documento crea, a lo sumo, un intent con origen en esa fuente y
  una pregunta de confirmación. Nunca se ejecuta directo.
- En una transcripción, sólo los acuerdos («quedamos en») proponen decisiones;
  lo demás queda como contexto citable.

### 3. Un documento largo es un plan, no treinta tareas

Pasa por el razonador (ADR-0036) y produce una tarjeta de plan agrupada por
feature, que se aprueba de una vez.

### 4. Vincular a mano

En el visor, un pasaje se vincula a una tarea, una decisión o una invariante
como requisito o evidencia.

### 5. Primera versión

Texto pegado, `.md`, `.txt`, `.docx` y PDF con texto. OCR, Drive y la
transcripción de Meet quedan para después, cada uno con su spike.

## Criterios de aceptación

- Un `.docx` con 30 pendientes produce una tarjeta de plan agrupada, no 30
  tareas.
- Un pasaje que pide borrar una tabla crea un intent con su pregunta, nunca una
  acción.
- Una decisión creada desde `S-4 §18` abre ese pasaje con un clic.

## Consecuencias

- El daemon suma parseo de `.docx` y PDF: dependencias nuevas que se miden en su
  spike.
- Las fuentes viven en el proyecto, no en la conversación: aparecen cuando otra
  tarea toca la misma entidad semanas después.

## Alternativas consideradas

- **Pegar el documento al agente.** Sin pasajes no hay citas, y el contenido de
  terceros entra como instrucción.
