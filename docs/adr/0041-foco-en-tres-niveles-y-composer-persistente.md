# ADR-0041: Foco en tres niveles y un composer que no se va

- **Estado:** Aceptado (2026-10-30)
- **Fecha:** 2026-10-30
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0034 (la GUI como superficie de foco): la extiende. Los lugares de la
    pila, el panel de contexto y el detalle encima ya existen.
  - ADR-0020 (el chat del run), ADR-0035 (la conversación orquesta).
  - Canvas: `CTO / 01…10` y `ds/CTO/FocusBar`, `ds/CTO/Composer`.

## Contexto

El research resume la UI en «el chat nunca desaparece; se encoge». Los frames
del canvas lo muestran con tres columnas:

- el hilo con el orquestador, angosto, con su composer;
- el foco: el plan, la bandeja, una tarea, una fuente, un artifact, el cierre o
  el replay;
- el lote en vivo.

ADR-0034 ya tiene la pila de lugares, el panel de contexto que empuja el layout
y el detalle encima. Falta el nivel chico (peek) y que el composer siga visible
en cualquier foco.

## Decisión

### 1. Tres niveles, todos lugares de la pila (ADR-0034 §4)

| Nivel      | Cuándo                                    | Forma                                                                      |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| Peek       | Mirar sin perder el hilo (pregunta, gate) | Popover anclado a la tarjeta (`ui/Popover`)                                |
| Panel      | Trabajar sobre algo (tarea, fuente, plan) | Columna de foco; el hilo se angosta                                        |
| Maximizado | Revisar a fondo (navegador, diff, canvas) | Pantalla completa; el hilo queda como tira con el composer flotante (`⌘J`) |

«Atrás» baja un nivel; `Esc` cierra el peek.

### 2. La conversación es la vista de tres columnas

- La **Conversación** del riel pasa a ser el hilo con el orquestador.
- El foco reusa las vistas que existen: la tarea abre `TaskFocus` (ADR-0034 §5)
  como panel; el lote en vivo reusa los carriles de subtareas.
- Desde el tablero, la tarea se sigue abriendo a pantalla completa.

### 3. El composer dice a quién le hablas

- Con una tarea en foco, el composer muestra su destino: «al orquestador» o «a
  T6». Por defecto es el orquestador; cambiarlo es un clic o `@T6`.
- Adjuntar convierte el archivo en fuente (ADR-0040).
- `@` menciona tareas, decisiones, fuentes y archivos; `#`, invariantes; `/`,
  comandos.

### 4. Atajos por foco

- Cada tarjeta muestra su atajo.
- El atajo vale en la tarjeta enfocada, no en toda la pantalla: dos tarjetas con
  `A` no chocan.

## Criterios de aceptación

- Desde el hilo, abrir T6 deja el hilo angosto con su composer. Escribir ahí con
  destino «a T6» llega al run de la tarea; «atrás» vuelve al hilo con su scroll.
- Una pregunta se contesta en su peek sin salir del hilo.
- Maximizado, `⌘J` abre el composer flotante.

## Consecuencias

- La conversación del proyecto deja de ser una página aparte con su propio
  layout.
- La vista de tarea se usa en dos tamaños: el panel de 560 px y la pantalla
  completa.

## Alternativas consideradas

- **Pestañas en vez de columnas.** Se pierde el hilo al abrir algo, que es justo
  lo que el research quiere evitar.
- **Un composer por vista.** Es lo que hay hoy: el humano tiene que saber dónde
  escribir.
