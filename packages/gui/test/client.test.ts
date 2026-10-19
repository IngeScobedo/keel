import { describe, expect, test } from "bun:test"
import { ErrorCode, failure, notification, Request, success } from "@keel/core"
import { KeelClient, type Wire } from "../src/client.js"

function makeWire(exchange: Wire["exchange"]): Wire {
  return {
    connect: async () => {},
    disconnect: async () => {},
    onEvent: async () => () => {},
    exchange,
  }
}
const health = {
  version: "0.0.0",
  event_loop_lag_ms: 1,
  rss_bytes: 1024,
  ingest_queue: 0,
  wal_bytes: 0,
}
describe("cliente GUI: frontera IPC", () => {
  test("valida params antes de enviarlos y la respuesta antes de usarla", async () => {
    let sent = 0
    const client = new KeelClient(
      makeWire(async (raw) => {
        sent++
        const frame = Request.parse(raw)
        return success(frame.id, health)
      }),
    )
    await expect(client.call("runs.start", {})).rejects.toThrow()
    expect(sent).toBe(0)
    expect(await client.call("daemon.health", {})).toEqual(health)
    const invalid = new KeelClient(
      makeWire(async (raw) => success(Request.parse(raw).id, { version: "fake" })),
    )
    await expect(invalid.call("daemon.health", {})).rejects.toThrow()
  })
  test("rechaza responses cruzadas y muestra errores del daemon", async () => {
    const crossed = new KeelClient(makeWire(async () => success("another-request", health)))
    await expect(crossed.call("daemon.health", {})).rejects.toThrow("correlación")
    const failed = new KeelClient(
      makeWire(async (raw) =>
        failure(Request.parse(raw).id, {
          code: ErrorCode.notFound,
          message: "No existe la tarea",
          retryable: false,
        }),
      ),
    )
    await expect(failed.call("daemon.health", {})).rejects.toThrow("No existe la tarea")
  })
  test("descarta eventos inválidos y respeta unsubscribe", async () => {
    let handle: ((raw: unknown) => void) | undefined
    let disposed = false
    const wire = makeWire(async () => null)
    wire.onEvent = async (handler) => {
      handle = handler
      return () => {
        disposed = true
      }
    }
    const client = new KeelClient(wire)
    const events: number[] = []
    const stop = await client.subscribe((event) => events.push(event.event_seq))
    handle?.(notification("events.event", { event_seq: "malformed" }))
    handle?.(
      notification("events.event", {
        event_seq: 4,
        kind: "work_item.created",
        project_id: "project",
        run_id: null,
        received_at: "2026-10-14T00:00:00Z",
      }),
    )
    expect(events).toEqual([4])
    stop()
    expect(disposed).toBe(true)
  })
})
