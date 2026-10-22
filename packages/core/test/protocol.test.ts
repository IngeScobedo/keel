import { describe, expect, test } from "bun:test"
import {
  decodeFrame,
  ErrorCode,
  encodeFrame,
  failure,
  KEEL_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  METHOD_NAMES,
  notification,
  request,
  success,
  validateParams,
} from "../src/index.ts"

describe("ADR-0005: contrato IPC", () => {
  test("round trip de request, success, error y notification por NDJSON", () => {
    const frames = [
      request(1, "runs.start", {
        request_id: "r1",
        idempotency_key: "k1",
        work_item_id: "wi",
        purpose: "execute",
      }),
      success("abc", { ok: true }),
      failure(null, { code: ErrorCode.parseError, message: "x", retryable: false }),
      notification("events.event", { event_seq: 1 }),
    ]
    for (const f of frames) {
      const line = encodeFrame(f)
      expect(line).not.toContain("\n")
      const d = decodeFrame(line)
      expect(d.ok).toBe(true)
      if (d.ok) expect(d.frame).toEqual(f)
    }
  })

  test("versión de protocolo obligatoria y correcta", () => {
    const d = decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.health" }))
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.error.code).toBe(ErrorCode.protocolVersion)
      expect(d.id).toBe(1)
    }
    expect(KEEL_PROTOCOL_VERSION).toBe(1)
  })

  test("JSON roto y frames gigantes no lanzan: devuelven error estructurado", () => {
    const broken = decodeFrame("{nope")
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error.code).toBe(ErrorCode.parseError)
    const huge = decodeFrame(`{"x":"${"a".repeat(MAX_FRAME_BYTES)}"}`)
    expect(huge.ok).toBe(false)
    if (!huge.ok) expect(huge.error.code).toBe(ErrorCode.frameTooLarge)
  })

  test("mutaciones exigen request_id e idempotency_key; lecturas no", () => {
    const bad = validateParams("runs.cancel", { run_id: "r1" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe(ErrorCode.invalidParams)
    const good = validateParams("runs.cancel", {
      run_id: "r1",
      request_id: "q",
      idempotency_key: "k",
    })
    expect(good.ok).toBe(true)
    const read = validateParams("events.subscribe", {})
    expect(read.ok).toBe(true)
    if (read.ok) expect((read.params as { after_event_seq: number }).after_event_seq).toBe(0)
  })

  test("método desconocido → methodNotFound; el catálogo cubre el SDD 02 §2", () => {
    const r = validateParams("nope.method", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(ErrorCode.methodNotFound)
    // K-01: propiedades heredadas de Object no son métodos del catálogo
    for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const h = validateParams(inherited, {})
      expect(h.ok).toBe(false)
      if (!h.ok) expect(h.error.code).toBe(ErrorCode.methodNotFound)
    }
    for (const m of [
      "work_items.create",
      "work_items.transition",
      "runs.start",
      "runs.pause",
      "runs.resume",
      "runs.cancel",
      "approvals.resolve",
      "events.subscribe",
      "fs.read",
      "diff.read",
      "pty.attach",
    ]) {
      expect(METHOD_NAMES as readonly string[]).toContain(m)
    }
  })

  test("approvals.resolve exige el hash exacto de la operación", () => {
    const r = validateParams("approvals.resolve", {
      request_id: "q",
      idempotency_key: "k",
      approval_id: "a",
      decision: "approve_once",
    })
    expect(r.ok).toBe(false)
  })
})
