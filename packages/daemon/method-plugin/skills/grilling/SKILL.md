---
name: grilling
description: Interroga al humano para afilar un pedido, un plan o un diseño antes de construir. Úsala al empezar el brief de cualquier tarea no trivial, o cuando el humano diga "interrógame", "grill", "estresa este plan". Una pregunta a la vez, con tu respuesta recomendada; lee el repo antes de preguntar.
---

# Grilling

1. **Una pregunta a la vez.** Espera la respuesta antes de seguir. Sólo agrupa
   2–3 subpreguntas de la misma rama si están muy acopladas.
2. **Rama por rama.** No preguntes B si depende de A y A sigue abierta.
3. **Con tu recomendación.** Propón la opción que elegirías y por qué, para
   que el humano reaccione en vez de redactar:

   > **[Rama: modelo de datos]** ¿El límite es por usuario o global?
   > Recomiendo por usuario: ya existe `redemptions.userId` (lo leí).

4. **Si está en el repo, léelo.** Antes de cada pregunta mira el código, el
   canon del proyecto (ADR, SDD, convenciones) y el contexto de Keel
   (`context_search`, notas de la tarea). Preguntar lo que ya está escrito
   quema confianza.
5. **Hasta el entendimiento compartido.** Busca el modo de fallo y los
   supuestos; termina cuando no quede ambigüedad que bloquee el siguiente paso.

Usa `AskUserQuestion` sólo para preguntas con opciones claras o para confirmar
el brief al final; el interrogatorio es conversación.

Al terminar di tu recomendación de **ceremonia**:

- **directo**: lo normal. Fixes, ajustes y features chicas.
- **formal**: si toca un contrato público o un invariante del proyecto, si
  necesita dos responsables en paralelo o si es un módulo grande sin SDD.

Atribución: método de `grill-me` (Matt Pocock, MIT) y catálogo de elicitación
de BMAD-METHOD, vía el harness de Casa Matte.
