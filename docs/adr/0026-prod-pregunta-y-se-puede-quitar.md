# ADR-0026: En producción Keel pregunta, y el humano puede quitar la pregunta asumiendo el riesgo

- **Estado:** Propuesto
- **Fecha:** 2026-10-26
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0013 §4: supersede la regla «en `prod`, las escrituras, `command.run` y
    `apply` nunca son `auto`». También §5 en lo que toca a la lista de comandos
    de Keel para SSH.
  - ADR-0025 §7: supersede «en `prod`, escribir, `ssh_run` e `iac_apply` nunca
    son `auto`» y «en `prod`, sólo esta vez».
  - ADR-0011 §8 (producción como `restricted`), ADR-0009 (actor agente).

## Contexto

Al revisar el alta de una conexión en el canvas (2026-10-26), el humano:

> Lo que no me gusta es lo de comandos permitidos en prod al crear la conexión,
> simplemente que en prod pida permiso para ejecutar y que si quiere pues lo
> pueda deshabilitar pero con el confirm de riesgo

Hoy, ADR-0013 y ADR-0025 hacen que en producción ejecutar siempre pregunte, sin
salida, y el alta de SSH pide una lista de comandos permitidos como capa de
Keel.

## Decisión

1. **El alta no pide comandos permitidos.** Una conexión se crea con su host, su
   entorno y su método de entrada (ADR-0025 §3). La garantía sigue estando en el
   servidor (ADR-0013 §5): Keel la recomienda, por ejemplo con la llave generada
   y su `command=`, pero no la exige al crear.
2. **En `prod`, cada ejecución pregunta por defecto.** Esto aplica a `ssh_run`,
   `sftp_write`, `db_execute` e `iac_apply`. La aprobación se ata al digest de
   la operación exacta (ADR-0025 §7).
3. **El humano puede quitar la pregunta**, por conexión y operación, con una
   confirmación de riesgo:
   - un diálogo que dice qué deja de preguntarse y en qué conexión;
   - el humano escribe el nombre de la conexión para confirmar;
   - queda un evento `grant.risk_accepted` con quién, cuándo y qué.

   Desde ese momento la conexión muestra «prod sin preguntar» en su ficha, en
   cada operación del chat y en el run. Volver a preguntar es un clic, sin
   confirmación.

4. **Sólo el humano.** Quitar la pregunta sólo se puede por la puerta humana
   (ADR-0018 §2). Un agente no puede pedirlo con `setup_request` (ADR-0025 §6):
   el esquema lo rechaza.
5. **Lo que no cambia:**
   - `iac_apply` sólo ejecuta el plan cuyo hash se aprobó (ADR-0013 §5). Sin
     pregunta, aplica el plan que el mismo run generó, y lo deja como evidencia.
   - La redacción, los límites y la auditoría de ADR-0025 §8.
   - Fuera de `prod`, las reglas de ADR-0013 §4.

## Criterios de aceptación

- El alta de una conexión SSH no tiene campo de comandos permitidos.
- En `prod`, `ssh_run` pregunta. Tras quitar la pregunta con la confirmación, el
  mismo comando corre sin preguntar y la tarjeta del chat dice «prod sin
  preguntar».
- Sin escribir el nombre de la conexión, la confirmación no se puede enviar.
- Un agente que intenta poner `auto` en `prod` recibe un rechazo.
- `grant.risk_accepted` queda en los eventos, con el actor humano.

## Consecuencias

- El humano decide cuánto riesgo asume en sus servidores. Keel lo hace visible,
  no lo prohíbe.
- Un error del agente en `prod` sin pregunta llega al servidor. La defensa queda
  en la garantía del servidor y en la auditoría.

## Alternativas consideradas

- **Mantener «en prod nunca auto».** Es más seguro, pero obliga a aprobar cada
  comando de un despliegue repetido. El humano lo rechazó.
- **Lista de comandos permitidos en el alta.** Es frágil (un prefijo permitido
  admite cualquier argumento) y es un paso más al crear. El humano lo rechazó.
