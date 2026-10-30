# ADR-0037: Decisiones, supuestos e invariantes como objetos

- **Estado:** Aceptado (2026-10-30)
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0021 §5: `invariants` del perfil pasa de patrones a reglas con
    contenido.
  - ADR-0035 (lote), ADR-0036 (el razonador detecta ratificaciones y
    correcciones), ADR-0038 (un supuesto bloqueante detiene el cierre; un waiver
    es una decisión).
  - ADR-0016 (un veredicto de research propone una decisión).
  - ADR-0004 (store), ADR-0005 (protocolo).

## Contexto

En la sesión de Casa Matte, la mitad del valor estuvo en cosas que no son
tareas:

- cinco decisiones con recomendación que el humano ratificó;
- cuatro decisiones que los agentes tomaron solos;
- una corrección («no puedes ver el avance antes de la propuesta») que debía
  valer para todo el trabajo futuro.

Hoy Keel no tiene dónde guardarlas. `invariants` del perfil (ADR-0021 §5) son
sólo patrones que exigen un ADR en el diseño.

## Decisión

### 1. Tres objetos del proyecto, con procedencia

| Objeto     | Clave | Estados                                               | Nace de                                                     |
| ---------- | ----- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Decisión   | `D-n` | `pendiente` → `ratificada` / `rechazada` / `diferida` | Una propuesta, un research, el humano                       |
| Supuesto   | `A-n` | `provisional` → `ratificado` / `revertido`            | Un agente que decidió sin preguntar (tool `assumption_add`) |
| Invariante | `I-n` | `activa` / `retirada`                                 | Una corrección del humano, un documento o un ADR            |

- Cada uno cita su origen: mensaje con su tramo, pasaje de una fuente
  (ADR-0040), comentario de un artifact o run.
- **Sólo el humano** ratifica, rechaza, difiere, revierte o retira. El agente
  propone.

### 2. Decisión

- Lleva opciones, la recomendada marcada y evidencia citada.
- Ratificar una decisión que pide trabajo crea sus tareas en el lote; una con
  impacto de arquitectura crea además un borrador de ADR en Propuesto.

### 3. Supuesto

- Lleva qué se decidió, por qué y el costo de revertir: `una-línea`, `local` o
  `transversal`.
- Puede **bloquear el merge**: el cierre del lote (ADR-0038) no termina con
  supuestos bloqueantes sin ratificar.

### 4. Invariante

- Lleva la regla en una frase, su alcance (globs o entidades) y, cuando existe,
  el test que la fija.
- **Se inyecta** en el contexto de toda tarea cuyo alcance la toque (ADR-0017).
- Reemplaza a `invariants` del perfil: un patrón viejo pasa a ser una invariante
  con texto «tocar esto exige ADR».

### 5. Se ven donde se usan

- En la conversación: una tarjeta por objeto.
- En «Te necesita»: las pendientes, ordenadas por trabajo que desbloquean.
- En la tarea: sus supuestos y las invariantes que le aplican.

## Criterios de aceptación

- «No puedes ver el avance antes de la propuesta» crea `I-1` con su mensaje de
  origen, y la siguiente tarea que toca `features/projects/**` la recibe en su
  contexto.
- Un agente que registra un supuesto bloqueante deja el cierre del lote detenido
  hasta que el humano lo ratifica o lo revierte.
- Ratificar `D-1` desde «Te necesita» crea su tarea y desbloquea su carril.
- Un agente no puede ratificar nada.

## Consecuencias

- El store suma tres tablas y el protocolo sus métodos y eventos.
- El perfil del proyecto migra `invariants`.
- La bandeja crece. Mitigación: ordenar por trabajo que desbloquea y, si el
  humano lo decide, ratificar en bloque los supuestos de costo `una-línea` al
  cierre.

## Alternativas consideradas

- **Guardarlos como notas.** No tienen estado, ni bloquean, ni se inyectan.
- **Que los supuestos del agente sean preguntas.** Es la «tormenta de
  interrupciones» del research: el agente sigue trabajando sobre el supuesto y
  el humano lo revisa después.
