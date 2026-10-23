# Codex con la suscripción de ChatGPT: confirmado por el humano y encendido desde la GUI

- **Fecha:** 2026-10-23
- **Relacionados:** ADR-0008 §2 (aceptado; no se edita), ADR-0002, SDD 03
  migración 0011, SDD 04 Fase 1

## Qué dijo el humano

«ya acepta lo de el sdk de codex, si se puede utilizar ya lo confirmamos»
(2026-10-23). Lo confirma para **uso local con su propia cuenta**, que es lo que
ADR-0008 §2 deja detrás de una opción explícita suya.

ADR-0008 dice que la verificación de términos «se anota aquí», en el propio ADR.
Como ya está aceptado y un ADR aceptado no se edita, la confirmación queda en
esta revisión y en el SDD 04.

## Lo que no cambia

- Keel no hace el login: `codex login` en una terminal, por el usuario.
- Keel no lee `~/.codex/auth.json` ni ningún archivo de credenciales.
- No hay fallback entre suscripción y `api_key`.
- Distribuir o comercializar Keel con este modo, o una cuenta para varios
  usuarios, sigue fuera: la confirmación es para uso local.

## Lo que cambia

Antes sólo se encendía con `--codex-subscription` al arrancar el daemon. El
daemon que arranca la GUI (ADR-0019 §1) no lo pasaba, así que todo run de Codex
desde la ventana fallaba en el preflight.

Ahora hay un ajuste del usuario (`user_settings`, migración 0011) que el humano
enciende en **Project setup → Proveedores**:

- `settings.get` y `settings.codex_subscription_set` (sólo humano; un agente no
  los tiene en `AGENT_METHODS`).
- El cambio guarda quién y cuándo, y emite `settings.changed`.
- El flag de arranque sigue mandando: con `--codex-subscription` la casilla sale
  encendida y bloqueada.

Evidencia: `packages/daemon/test/codex.test.ts` (el run pasa de fallar en el
preflight a lanzarse tras el ajuste) y `packages/gui/e2e/live-daemon.spec.ts`
(la casilla contra un daemon real sin el flag).
