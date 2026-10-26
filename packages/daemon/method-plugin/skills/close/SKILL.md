---
name: close
description: Etapa close en Keel. Úsala para llevar lo durable de la tarea al canon del proyecto y proponer el commit para que el humano lo apruebe.
---

# Cierre

1. **Promueve al canon** lo que deba durar, en las rutas y el formato del
   proyecto (Keel te las da en el encabezado, o léelas del repo):
   - un ADR por decisión, con la numeración y el prefijo del proyecto;
   - un SDD nuevo o enmendado si cambió el diseño de un módulo;
   - el roadmap o el backlog al día.

   No inventes el porqué: marca `[INFERIDO — confirmar]` lo que no sea evidente.
2. **Propón el commit** con `git_propose`, siguiendo la convención de ramas y
   commits del proyecto. El humano aprueba el plan (gate c) y Keel lo ejecuta
   revalidando; tú no haces `git push`.
3. **Deja una nota** con `note_add`: qué se hizo, qué quedó pendiente y dónde
   quedó cada cosa.
