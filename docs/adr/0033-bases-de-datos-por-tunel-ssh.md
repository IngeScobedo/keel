# ADR-0033: Bases de datos detrás de un túnel SSH

- **Estado:** Aceptado (2026-10-28)
- **Fecha:** 2026-10-28
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0013 §7: supersede «conexiones locales al host del daemon (o por un
    túnel que el humano ya tenga)». Keel abre el túnel él mismo.
  - ADR-0025: usa sus conexiones SSH, su `known_hosts`, su `ssh-agent` y askpass
    (§3, §4), y la política de `prod` (§7). ADR-0026.
  - ADR-0013 §5: la lectura la sigue garantizando la base (rol de sólo lectura,
    `READ ONLY`, tope de filas).
  - ADR-0031: el mismo principio, las opciones de Keel primero.

## Contexto

El humano (2026-10-28):

> algo que ocupo para los source de db es poder soportar los túneles ssh para
> una conexión, ya sea utilizar un ssh source ya creado en keel o crear uno
> nuevo y configurarlo, hacer test de que lea la bd y eso. No ocupo aún nada
> para gestionar o ver tablas, con que tenga acceso el agente y quede ligado al
> proyecto, así si ocupo consultar algo de prod o dev en la bd lo pueda hacer.

Lo que hay:

- Keel ya tiene conexiones PostgreSQL con su contraseña en el vault, y el agente
  consulta con `db_query` por el broker. Pero sólo alcanza bases a las que el
  daemon llega directo.
- La base de Casa Matte escucha en `127.0.0.1:5432` del VPS: sin túnel no se
  alcanza.
- **El spike `spikes/db-tunnel`** (2026-10-28, contra ese VPS y sin credenciales
  de la base) midió:
  - Como Keel (`-F none`, sin conexión compartida), el túnel abre en 1 s, la
    primera conexión por él tarda 547 ms y las siguientes unos 280 ms. Al
    cerrar, `ssh` sale en 3 ms y el puerto se libera.
  - Con la config del humano (`ControlMaster auto`, `ControlPersist 10m`), el
    reenvío queda montado en su proceso maestro: al terminar, **el puerto hacia
    la base sigue abierto** hasta 10 minutos.

## Decisión

### 1. Una conexión de base puede ir por una conexión SSH

- Una conexión PostgreSQL declara `via`: el nombre de una conexión SSH del
  proyecto. Su `host` y `port` son los que ve el servidor SSH (por ejemplo,
  `127.0.0.1:5432`).
- **En el formulario**, «Llegar por un túnel SSH» ofrece:
  - elegir una conexión SSH existente;
  - o crear una nueva ahí mismo, con el formulario de SSH; al guardarla, queda
    elegida.
- **El entorno** de la base no puede ser menor que el de su conexión SSH: por un
  servidor de `prod`, la base es `prod`.

### 2. Keel abre el túnel por cada uso y lo cierra

- Keel lanza `ssh -N -L 127.0.0.1:<puerto libre>:<host>:<port>` con:
  - `-F none`, `ControlMaster=no`, `ControlPath=none` y
    `ExitOnForwardFailure=yes`;
  - las opciones de la conexión SSH: su huella en el `known_hosts` de Keel, su
    llave o su agente, y askpass.
- **Nunca la config del humano.** El spike mostró que con su `ControlMaster` el
  puerto queda abierto después de terminar.
- **El puerto** es aleatorio, sólo en `127.0.0.1`, y nadie más lo recibe: la
  operación lo usa y lo cierra.
- **Reuso corto:** si el mismo run hace otra consulta a la misma conexión en
  menos de 60 s, reusa el túnel abierto. Un túnel sin uso se cierra a los 60 s,
  y siempre al terminar el run o el daemon.
- **Si el túnel no abre** (huella, llave, red), la operación falla con el
  mensaje de `ssh`, redactado, y nada queda abierto.

### 3. «Probar conexión»

- La conexión tiene «Probar», y `connections.test` lo hace por el mismo camino:
  abre el túnel si hay `via`, se conecta y corre, en una transacción
  `READ ONLY`, `select current_user, current_database(), version()` y
  `show transaction_read_only`.
- **El resultado se ve en la conexión:**
  - a qué base y con qué usuario entró;
  - la versión;
  - cuánto tardó cada tramo (túnel y base);
  - si hay credencial de sólo lectura y si la lectura está garantizada por la
    base.
- Sólo el humano prueba. La prueba no pasa por grants ni deja datos de tablas.

### 4. El agente

- No cambia lo que el agente puede hacer: `db_query` sobre las conexiones del
  proyecto, con los grants de ADR-0013 y ADR-0025 §7. En `prod` pregunta.
- El túnel es transparente para el agente: nunca ve el puerto, la llave ni la
  contraseña.

### 5. Lo que no hace

- No hay explorador de tablas ni gestión de la base.
- Por ahora sólo PostgreSQL. SQLite es local por naturaleza; MySQL, cuando
  exista su conexión.

## Criterios de aceptación

- Una conexión PostgreSQL con `via: prod-casamatte`, `127.0.0.1:5432` y su
  contraseña en el vault: «Probar» muestra usuario, base y versión.
- Desde una tarea, `db_query` pregunta en `prod` y, aprobado, devuelve filas.
- Al terminar no queda ningún puerto local abierto, aunque el humano tenga
  `ControlMaster` en su config.
- Con una huella distinta en la conexión SSH, la prueba falla sin abrir nada.
- Crear la conexión SSH desde el formulario de la base la deja elegida en `via`.

## Consecuencias

- Keel alcanza bases que sólo escuchan en el servidor sin que el humano deje un
  túnel abierto a mano.
- Cada uso aislado cuesta 1 s más por abrir el túnel; el reuso de 60 s lo baja
  para consultas seguidas.

## Alternativas consideradas

- **Que el humano abra su túnel y Keel apunte a `localhost`.** Es lo que dejaba
  ADR-0013 §7: Keel no sabe si el túnel existe ni a qué servidor va, y queda
  abierto todo el día.
- **Un túnel permanente por conexión.** Deja un puerto hacia `prod` abierto
  aunque nadie consulte.
- **Usar la config SSH del humano.** El spike mostró que deja el puerto abierto,
  y ata a Keel a lo que tenga cada máquina.
