---
name: infra
description:
  Infraestructura en Keel. Úsala cuando la tarea toque un servidor, una base de
  datos, un despliegue, Terraform o una migración que aplicar, para usar las
  conexiones del proyecto o pedir la que falta.
---

# Infraestructura con Keel

El agente no tiene credenciales ni las pide. Keel guarda las conexiones del
proyecto en su vault y ejecuta por ti: `resources_list` las muestra con sus
operaciones y su política, y `ssh_run` y `db_query` (con `write: true` para
escribir) las usan. En producción cada ejecución le pregunta al humano.

## Antes de pedir algo, mira

- scripts de despliegue (`deploy.sh`, `Makefile`, `package.json`);
- `infrastructure/`, `deploy/`, `.github/workflows/`;
- archivos de Terraform (`*.tf`);
- el ORM y sus migraciones (`prisma/`, `drizzle/`, `migrations/`).

## Si falta, pídelo con `setup_request`

- **Una conexión.** Lo concreto que encontraste: tipo (`ssh`, `postgres`,
  `terraform`), nombre, entorno (`dev`, `staging`, `prod`), host, usuario y
  puerto, y en `evidence` el archivo y la línea. No una conexión genérica.
- **Un permiso** (`grant`), si la conexión ya existe y no puedes usar una
  operación. Pídelo en `ask`; quitar la pregunta en producción es decisión del
  humano en la conexión.
- Nunca pongas contraseñas, llaves ni tokens en la propuesta: Keel la rechaza.
  El humano elige cómo entra la conexión (su agente SSH, una llave de Keel, una
  contraseña en el vault o que se la pregunte cada vez).

Espera la respuesta: te dice qué quedó listo y con qué política. Si el humano no
la configura, no la pidas de nuevo en el mismo turno.
