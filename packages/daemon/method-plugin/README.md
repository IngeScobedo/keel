# Plugin `keel-method`

El método con el que Keel conduce una tarea (ADR-0021). Keel lo pasa al Claude
Agent SDK como plugin local en cada run (`plugins: [{ type: "local" }]`): el
repo del proyecto no recibe ningún archivo.

Destilado del harness de Casa Matte (`framework/method`, `framework/harness`,
`changes/`), que a su vez destila BMAD-METHOD (`bmad-code-org/BMAD-METHOD`),
OpenSpec y `grill-me` de Matt Pocock (`mattpocock/skills`, MIT).

- `skills/`: un procedimiento por etapa más el interrogatorio (`grilling`).
- `agents/`: los roles con frontera dura (analyst, architect, engineer,
  reviewer).

Lo mecánico no está aquí: la legalidad de las etapas, la validación de los
documentos y la verificación las hace el daemon con código (`@keel/core`,
`verify.ts`), y el agente sólo recibe el resultado.
