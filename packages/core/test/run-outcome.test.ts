import { describe, expect, test } from "bun:test"
import { classifyRunOutcome, type RunOutcome, type RunSignals } from "../src/index.ts"

const pick = (o: RunOutcome) => [o.status, o.end_reason, o.category, o.user_action] as const
const result = (subtype: string, extra: Partial<NonNullable<RunSignals["result"]>> = {}) => ({
  result: { subtype, is_error: subtype !== "success", ...extra },
})

describe("Fase 1: salidas explícitas de un run (ADR-0006 §5 para status y end_reason)", () => {
  test.each([
    ["éxito", result("success"), ["completed", "completed", "completed", null]],
    ["cancelado", { aborted: "cancelled" }, ["cancelled", "cancelled", "cancelled", null]],
    ["tiempo máximo", { aborted: "timeout" }, ["interrupted", "timeout", "timeout", "raise_limit"]],
    [
      "presupuesto del SDK",
      result("error_max_budget_usd"),
      ["budget_exceeded", "budget_exceeded", "budget", "raise_limit"],
    ],
    [
      "max_turns",
      result("error_max_turns"),
      ["failed", "fatal_error", "turn_limit", "raise_limit"],
    ],
    [
      "auth caducada con sesión de suscripción",
      {
        ...result("success", { is_error: true }),
        providerError: "authentication_failed",
        authMode: "subscription_session",
      },
      ["failed", "fatal_error", "auth", "provider_login"],
    ],
    [
      "auth fallida con api_key",
      { providerError: "authentication_failed", authMode: "api_key" },
      ["failed", "fatal_error", "auth", "check_api_key"],
    ],
    [
      "facturación",
      { providerError: "billing_error" },
      ["failed", "fatal_error", "billing", "check_billing"],
    ],
    [
      "rate limit es interrupted",
      { providerError: "rate_limit" },
      ["interrupted", "rate_limit", "rate_limit", "wait_and_retry"],
    ],
    [
      "StopFailure overloaded es interrupted",
      { stopFailure: "overloaded" },
      ["interrupted", "interrupted", "overloaded", "wait_and_retry"],
    ],
    [
      "modelo inexistente: sin capacidad",
      { providerError: "model_not_found" },
      ["failed", "fatal_error", "capability", "change_model"],
    ],
    [
      "CLI demasiado viejo al arrancar",
      result("error_during_execution", { startup_failure_reason: "cli_version_too_old" }),
      ["failed", "fatal_error", "capability", "update_provider"],
    ],
    [
      "cwd inutilizable al arrancar",
      result("error_during_execution", { startup_failure_reason: "cwd_unavailable" }),
      ["failed", "fatal_error", "environment", "fix_environment"],
    ],
    [
      "proceso muerto por señal",
      { exit: { code: null, signal: "SIGKILL" } },
      ["interrupted", "interrupted", "provider_crashed", "retry"],
    ],
    [
      "proceso con código de error",
      { exit: { code: 3, signal: null } },
      ["interrupted", "interrupted", "provider_crashed", "retry"],
    ],
    ["stream cortado sin result", {}, ["interrupted", "interrupted", "stream_incomplete", "retry"]],
  ] as [string, RunSignals, readonly unknown[]][])("%s", (_name, signals, expected) => {
    expect(pick(classifyRunOutcome(signals))).toEqual(expected as never)
  })

  test("un error sin código conocido nunca se lee como éxito", () => {
    const o = classifyRunOutcome(result("error_during_execution"))
    expect(o.status).toBe("failed")
    expect(o.category).toBe("unknown")
  })

  test("la cancelación humana gana a cualquier otra señal", () => {
    expect(
      classifyRunOutcome({
        aborted: "cancelled",
        providerError: "rate_limit",
        exit: { code: 1, signal: null },
      }).status,
    ).toBe("cancelled")
  })
})
