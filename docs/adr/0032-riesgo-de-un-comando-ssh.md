# ADR-0032: El riesgo de un comando SSH lo clasifica Keel antes de correrlo

- **Estado:** Propuesto
- **Fecha:** 2026-10-28
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0025 §7 (política y aprobación): supersede «en `prod`, `ssh_run` nunca
    es `auto`» sólo para los comandos que este ADR clasifica como lectura, y
    sólo si el humano lo enciende en la conexión.
  - ADR-0026 (Propuesto: en prod se pregunta y se puede quitar). Este ADR lo
    afina por clase de comando.
  - ADR-0013 §5: la garantía real sigue en el servidor (usuario restringido o
    comando forzado); la clase es una capa de Keel.
  - ADR-0031 §5: la tarjeta de SSH muestra la clase.

## Contexto

El humano (2026-10-28), al pedir que la infraestructura se vea de primer nivel,
pegó una guía. De ella, lo que toca la política es esto:

> Pre-Flight Check (Clasificador de Riesgo): tu wrapper analiza el AST del
> comando bash antes de enviarlo por el canal SSH. Verde (Read-Only): ls, cat,
> docker ps, systemctl status, df -h, grep ➔ se ejecuta directo sin preguntar.
> Amarillo (Mutación de Servicio): systemctl restart, docker compose up -d, git
> pull ➔ pide confirmación rápida. Rojo (Destructivo / Sistema): rm -rf, mkfs,
> dd, iptables -F, DROP DATABASE ➔ bloqueo obligatorio con UI de confirmación
> explícita.

Lo que hay:

- Hoy todo `ssh_run` se trata igual. En `prod` siempre pregunta, sea un
  `docker ps` o un `rm -rf`, y una aprobación «para la tarea» cubre los dos.
- Preguntar por cada lectura entrena al humano a aprobar sin leer, justo lo que
  hace peligroso al comando rojo.
- `@keel/core` no tiene un clasificador de comandos: la etapa de sólo lectura
  (ADR-0021 §3) niega por herramienta, no por comando.

## Decisión

### 1. Tres clases, decididas por código

Keel analiza el comando (tokens de shell, no texto con regex) antes de mandarlo,
y le asigna una clase:

- **Lectura (verde).** Cada segmento de la tubería es un programa de una lista
  de sólo lectura con argumentos que no escriben. Por ejemplo: `ls`, `cat`,
  `head`, `tail`, `grep`, `df`, `du`, `free`, `uptime`, `ps`, `ss`,
  `journalctl`, `systemctl status`, `docker ps`, `docker logs`,
  `docker inspect`, `pm2 list` y `pm2 logs --nostream`. No puede haber
  redirección a archivo (`>`, `>>`, `tee`), `sudo`, sustitución de comandos ni
  `;`, `&&` o `||` hacia un segmento que no sea de lectura.
- **Servicio (amarillo).** Cambia el estado de un servicio sin borrar datos:
  `systemctl restart|reload`, `docker compose up|restart`, `pm2 restart`,
  `git pull`, `nginx -s reload`. También todo lo que Keel no reconoce: lo
  desconocido nunca es verde.
- **Destructivo (rojo).** Borra o deja el sistema sin servicio: `rm -r`, `mkfs`,
  `dd`, `iptables -F`, `shutdown`, `reboot`, `kill -9 1`, `docker system prune`,
  `DROP` o `TRUNCATE` dentro de `psql -c`, y `chmod -R` o `chown -R` sobre `/`.

Las listas viven en `@keel/core`, son puras y se prueban con ejemplos. Un
comando que no se puede analizar (comillas sin cerrar, heredocs) es rojo.

### 2. Lo que hace cada clase

- **Verde.**
  - En `dev` y `staging` corre sin preguntar, aunque la conexión esté en `ask`.
  - En `prod` pregunta, salvo que el humano encienda en la conexión «lecturas
    sin preguntar». Ese ajuste queda a su nombre y la conexión lo muestra.
- **Amarillo.** Pregunta como hoy. Una aprobación «para la tarea» sólo cubre
  comandos amarillos con el mismo programa y subcomando.
- **Rojo.**
  - Pregunta siempre. Ningún grant, regla ni aprobación de sesión lo cubre.
  - En `prod`, la tarjeta pide escribir el nombre de la conexión, como ADR-0026.
  - El agente recibe la clase antes de pedirlo, para que proponga una
    alternativa menos destructiva si la hay.

### 3. Se ve

- La tarjeta de SSH (ADR-0031 §5) y la aprobación llevan la clase: «lectura» en
  verde, «servicio» en amarillo y «destructivo» en rojo, con el segmento que la
  decidió.
- La auditoría guarda la clase con la operación (ADR-0025 §8).

### 4. Lo que no hace

- No es la garantía. Un usuario restringido o un comando forzado en el servidor
  siguen siendo lo que de verdad limita (ADR-0013 §5), y la conexión lo dice.
- No cubre las métricas del host ni el reenvío de puertos de la guía: si se
  quieren, van en otro ADR.

## Criterios de aceptación

- `docker ps` en `staging` con la conexión en `ask` corre sin preguntar.
- `docker ps` en `prod` pregunta, salvo con «lecturas sin preguntar» encendido.
- `docker ps && rm -rf /srv/app` es rojo: el segmento `rm -rf` lo decide.
- `cat log > /tmp/x` no es verde.
- `systemctl restart nginx` aprobado «para la tarea» no cubre `rm -rf /srv`.
- `rm -rf /srv/app` en `prod` pide escribir el nombre de la conexión, aunque
  haya un grant `auto` con el riesgo aceptado.
- Un comando con comillas sin cerrar es rojo.

## Consecuencias

- Menos preguntas por lecturas y más atención en lo destructivo.
- Las listas hay que mantenerlas. Un falso verde es el error caro; por eso lo
  desconocido es amarillo y lo que no se puede analizar es rojo.

## Alternativas consideradas

- **Que la clase la decida el agente.** No es determinista, y el agente es la
  parte que se quiere acotar.
- **Regex sobre el texto.** Se engaña con comillas, `$()` y `;`; la guía misma
  pide analizar el AST.
- **Dejar todo como está.** Las preguntas por lecturas siguen gastando la
  atención del humano.
