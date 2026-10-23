/**
 * Cómo terminó un run, a partir de las señales del proveedor y del proceso
 * (Fase 1, SDD 04: «auth expirada, proveedor sin capacidad, sidecar muerto y
 * stream incompleto tienen salidas explícitas»).
 *
 * Tabla pura e independiente del proveedor: el adaptador de Claude traduce sus
 * mensajes a `RunSignals`, y el de Codex hará lo mismo. El resultado respeta el
 * vocabulario cerrado de ADR-0006: `status` y `end_reason` de siempre. La causa
 * concreta va en `category`, y lo que tiene que hacer el humano en
 * `user_action`, una clave que la UI traduce. Nunca un fallback silencioso: un
 * fallo de auth no se reintenta con otra cuenta (ADR-0002).
 */
import type { RunStatus } from "./visual-state.js"

export type EndReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "budget_exceeded"
  | "rate_limit"
  | "fatal_error"
  | "cancelled"

export type FailureCategory =
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "capability"
  | "environment"
  | "provider_crashed"
  | "stream_incomplete"
  | "timeout"
  | "turn_limit"
  | "budget"
  | "model"
  | "unknown"

/** Qué puede hacer el humano. La UI lo traduce; `null` si no hay nada que hacer. */
export type UserAction =
  | "provider_login"
  | "check_api_key"
  | "check_billing"
  | "wait_and_retry"
  | "retry"
  | "raise_limit"
  | "update_provider"
  | "change_model"
  | "fix_environment"
  | "inspect_logs"

export type RunSignals = {
  /** El `result` del proveedor, si llegó. */
  result?: {
    subtype: string
    is_error: boolean
    errors?: readonly string[]
    startup_failure_reason?: string | null
    terminal_reason?: string | null
  } | null
  /** Último error que el proveedor adjuntó a un mensaje del asistente (p. ej. `authentication_failed`). */
  providerError?: string | null
  /** Error de un hook `StopFailure`. */
  stopFailure?: string | null
  /** Salida del proceso del proveedor, si Keel lo lanzó y terminó. */
  exit?: { code: number | null; signal: string | null } | null
  /** Keel abortó el run: el humano lo canceló o venció el tiempo máximo. */
  aborted?: "cancelled" | "timeout" | null
  /** El stream lanzó una excepción (mensaje). */
  thrown?: string | null
  /** Modo de autenticación del perfil, para elegir la acción en fallos de auth. */
  authMode?: string | null
}

export type RunOutcome = {
  status: Extract<
    RunStatus,
    "completed" | "failed" | "cancelled" | "interrupted" | "budget_exceeded"
  >
  end_reason: EndReason
  category: FailureCategory | "completed" | "cancelled"
  retryable: boolean
  /** Código del proveedor o del proceso que motivó la clasificación. */
  provider_error: string | null
  user_action: UserAction | null
}

const AUTH = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
])
const STARTUP_AUTH = new Set([
  "gateway_signin_required",
  "gateway_access_denied",
  "org_verify_failed",
  "org_pin_mismatch",
  "org_pin_api_key_conflict",
])
const STARTUP_CAPABILITY = new Set(["cli_version_too_old", "provider_not_allowed"])

function outcome(
  status: RunOutcome["status"],
  end_reason: EndReason,
  category: RunOutcome["category"],
  retryable: boolean,
  provider_error: string | null,
  user_action: UserAction | null,
): RunOutcome {
  return { status, end_reason, category, retryable, provider_error, user_action }
}

/** Clasifica un error de proveedor (`SDKAssistantMessageError` y equivalentes). */
function fromProviderError(code: string, authMode: string | null | undefined): RunOutcome {
  if (AUTH.has(code))
    return outcome(
      "failed",
      "fatal_error",
      "auth",
      false,
      code,
      authMode === "subscription_session" ? "provider_login" : "check_api_key",
    )
  if (code === "billing_error")
    return outcome("failed", "fatal_error", "billing", false, code, "check_billing")
  // ADR-0006 §5: rate limit y StopFailure son `interrupted`, no `failed`.
  if (code === "rate_limit")
    return outcome("interrupted", "rate_limit", "rate_limit", true, code, "wait_and_retry")
  if (code === "overloaded" || code === "server_error")
    return outcome("interrupted", "interrupted", "overloaded", true, code, "wait_and_retry")
  if (code === "invalid_request" || code === "model_not_found")
    return outcome("failed", "fatal_error", "capability", false, code, "change_model")
  if (code === "max_output_tokens")
    return outcome("failed", "fatal_error", "model", false, code, "raise_limit")
  return outcome("failed", "fatal_error", "unknown", false, code, "inspect_logs")
}

export function classifyRunOutcome(s: RunSignals): RunOutcome {
  if (s.aborted === "cancelled")
    return outcome("cancelled", "cancelled", "cancelled", false, null, null)
  if (s.aborted === "timeout")
    return outcome("interrupted", "timeout", "timeout", true, null, "raise_limit")

  const r = s.result
  if (r) {
    if (r.subtype === "success" && !r.is_error)
      return outcome("completed", "completed", "completed", false, null, null)
    if (r.subtype === "error_max_budget_usd")
      return outcome(
        "budget_exceeded",
        "budget_exceeded",
        "budget",
        false,
        r.subtype,
        "raise_limit",
      )
    if (r.subtype === "error_max_turns")
      return outcome("failed", "fatal_error", "turn_limit", false, r.subtype, "raise_limit")
    const startup = r.startup_failure_reason ?? null
    if (startup) {
      if (STARTUP_AUTH.has(startup))
        return outcome("failed", "fatal_error", "auth", false, startup, "provider_login")
      if (STARTUP_CAPABILITY.has(startup))
        return outcome("failed", "fatal_error", "capability", false, startup, "update_provider")
      return outcome("failed", "fatal_error", "environment", false, startup, "fix_environment")
    }
  }
  const providerError = s.providerError ?? s.stopFailure ?? null
  if (providerError) return fromProviderError(providerError, s.authMode)
  if (r) return outcome("failed", "fatal_error", "unknown", false, r.subtype, "inspect_logs")

  // Sin `result`: el proceso murió o el stream se cortó. Nunca se inventa éxito.
  const exit = s.exit
  if (exit && (exit.signal !== null || (exit.code !== null && exit.code !== 0)))
    return outcome(
      "interrupted",
      "interrupted",
      "provider_crashed",
      true,
      exit.signal ?? `exit ${exit.code}`,
      "retry",
    )
  return outcome(
    "interrupted",
    "interrupted",
    s.thrown ? "provider_crashed" : "stream_incomplete",
    true,
    s.thrown ?? null,
    "retry",
  )
}
