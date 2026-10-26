# ADR-0023: El agente pide lo que le falta: `setup_request` y la GUI que responde

- **Estado:** Rechazado (2026-10-26). El humano quiere un vault propio de Keel,
  con importación desde el sistema, y separar el vault de cómo lo consume el
  agente. Lo reemplaza ADR-0025.
- **Fecha:** 2026-10-26
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0021 §7 (este ADR cumple lo que dejó pendiente).
  - ADR-0009 (tools MCP y actor agente).
  - ADR-0013 (intermediario de recursos y secretos): este ADR lo amplía en §3,
    sin cambiar lo que decide.
  - ADR-0014 (plugins).
  - ADR-0019 (GUI).
  - ADR-0020 (chat del run).

## Contexto

El humano no quiere aprender qué ofrece Keel para poder usarlo (2026-10-26):

> si detecta que le estoy pidiendo que despliegue y detecta que uso por ejemplo
> ssh o terraform […] que si no tengo conexiones ssh y el despliegue es por ssh
> que el agente te pida agregar al vault el ssh para que utilice la conexión, o
> que si quiere aplicar una migración te pida […] y que la GUI reaccione
> abriendo un modal o un componente que sea fácil agregar la conexión.

Lo que ya hay:

- **El intermediario de recursos (ADR-0013):**
  - conexiones `postgres`, `sqlite`, `ssh` y `terraform`, con su entorno y sus
    operaciones;
  - grants por operación; en producción, escribir nunca es `auto`;
  - secretos por referencia (`env:`, `keychain:`, `op://`, `vault:`), que el
    daemon resuelve sólo al ejecutar.
- **SSH** usa el `ssh` del usuario con sus llaves y su agente: no hay secreto
  que guardar, sólo host, usuario y puerto.
- **El agente** ve `resources_list` y ejecuta con `resources_execute`, pero no
  puede dar de alta nada. Si falta la conexión, hoy sólo puede decirlo en texto,
  y el humano tiene que saber dónde se configura.
- **El chat del run** (ADR-0020) ya resuelve tarjetas que piden algo al humano,
  como permisos, preguntas y gates.

## Decisión

### 1. `setup_request`: el agente propone, el humano configura

Una tool de Keel con la que el agente pide algo que falta en el proyecto:

| `kind`       | Qué propone                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `connection` | tipo, nombre, entorno, configuración sin secretos (host, usuario, puerto, base, ruta) y por qué |
| `grant`      | conexión, operación y política (`ask` o `auto`, nunca `auto` para escribir en prod)             |
| `plugin`     | un plugin instalable (ADR-0014) por su id                                                       |
| `profile`    | un cambio del perfil del proyecto, como un comando de verificación nuevo (ADR-0021 §5)          |

- **Nada se crea solo.** La petición es una solicitud del humano, como un
  permiso: queda en el chat y en el Inbox. Es una aprobación con
  `tool: "setup.request"` y la propuesta validada con Zod.
- **El agente nunca pasa secretos.** El esquema rechaza campos con forma de
  secreto, con la misma regla que el intermediario aplica a `config` (ADR-0013
  §1).

### 2. La GUI abre el formulario ya lleno

La tarjeta dice qué pide el agente y por qué, por ejemplo: «Para desplegar
necesito una conexión SSH a prod: deploy@203.0.113.10». El botón «Configurar»
abre el formulario de Keel para eso, con lo que propuso el agente:

- **Conexión:** el alta de ADR-0013 con nombre, tipo, entorno y configuración.
  El humano revisa, completa lo que falta y guarda.
- **Grant:** la operación y la política, con las reglas de producción a la
  vista.
- **Plugin:** el manifiesto, la versión y el hash, para instalarlo
  explícitamente.
- **Perfil:** el cambio sobre el perfil confirmado.

Al guardar, la solicitud se resuelve con el id de lo creado. El daemon le dice
al agente, en una línea, qué quedó listo, con qué operaciones y con qué
política. Si el humano lo rechaza, el agente recibe el motivo.

### 3. El secreto sin salir de la máquina

Para conexiones con secreto (bases de datos, Terraform), el formulario ofrece:

- escribir una referencia existente (`env:`, `op://`, `vault:`, `keychain:`);
- o pegar el valor para que el daemon lo guarde en el llavero del sistema como
  `keel/<proyecto>/<conexión>`, y quede sólo la referencia `keychain:`.

El valor pasa por la memoria del daemon el tiempo de escribirlo en el llavero.
No va a la base, a un evento, a un log ni al agente. Es el almacén externo que
ADR-0013 §1 ya admite: Keel no guarda el valor, lo deja en el llavero.

### 4. El agente sabe que está en Keel

- **El encabezado del prompt** (ADR-0017 §1) dice en una línea qué ofrece Keel:
  conexiones del proyecto por `resources_list` y pedir lo que falte con
  `setup_request`. No lista las conexiones.
- **El plugin del método** (ADR-0021) suma una skill `infra`: cuándo proponer
  una conexión, por ejemplo cuando el repo despliega por SSH o Terraform o hay
  una migración que aplicar. Le dice qué mirar antes de pedir:
  - scripts de despliegue;
  - `infrastructure/`, `deploy/`, workflows de CI;
  - archivos de Terraform;
  - el ORM y sus migraciones.

  Pide lo concreto que encontró, no una conexión genérica.

- **Si la conexión ya existe y le falta el grant,** pide el grant, no otra
  conexión.

### 5. Lo que no cambia

- Una conexión nueva empieza en `ask` para todo, y en producción escribir nunca
  es `auto` (ADR-0013 §4).
- La garantía sigue en el recurso (usuario restringido, rol de sólo lectura,
  plan de Terraform aprobado). La UI dice cuál tiene cada conexión.
- Un agente no puede crear, cambiar ni borrar conexiones, grants, plugins ni el
  perfil. Sólo pide.

## Criterios de aceptación

- **Conexión SSH.** En una tarea que pide desplegar en un repo con un script
  `ssh deploy@…`, el agente pide la conexión con host, usuario y entorno ya
  propuestos. La GUI abre el alta llena, el humano guarda y el agente recibe
  «conexión prod-ssh lista: command.run (ask)». Luego despliega por
  `resources_execute`, y cada comando pide permiso por ser producción.
- **Secreto en el llavero.** Con una conexión PostgreSQL y el valor pegado,
  `connections.list`, los eventos y los logs del daemon sólo muestran
  `keychain:keel/…`. El agente nunca ve el valor.
- **Secretos rechazados.** Un `setup_request` con un campo con forma de secreto
  se rechaza con un mensaje que dice usar una referencia.
- **Rechazo.** El agente recibe el motivo y no reintenta la misma petición en el
  mismo turno.
- **Grant y no conexión.** Una petición de grant para una conexión existente
  abre el formulario de grant, no el de conexión.

## Consecuencias

- El humano nunca necesita saber que existe la pantalla de conexiones: llega a
  ella desde lo que pide el agente.
- Guardar en el llavero hace que Keel escriba en un almacén del sistema. Linux
  necesita `secret-tool` (libsecret); sin él, el formulario sólo acepta
  referencias y lo dice.
- La skill `infra` cuesta contexto sólo cuando se carga: el modelo ve su
  descripción, no su cuerpo.

## Alternativas consideradas

- **Que el agente cree la conexión directamente.** Más rápido, pero da a un
  agente el poder de abrir accesos. ADR-0013 lo prohíbe en el espíritu: el
  humano concede.
- **Que el humano escriba el secreto en el chat.** Quedaría en el transcript del
  proveedor y en los eventos. El formulario lo evita.
- **Un asistente de configuración genérico al abrir el proyecto.** Pregunta por
  cosas que quizá nunca se usen. Pedir cuando hace falta, con lo que el agente
  ya encontró, es más barato y más claro.
