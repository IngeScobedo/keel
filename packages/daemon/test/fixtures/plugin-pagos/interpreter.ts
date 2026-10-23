/**
 * Plugin de ejemplo (ADR-0014): reconoce `mcp__pagos__list_charges` y emite
 * `payments.charges.listed`. Función pura de los eventos, sin E/S.
 * `bad` en la entrada produce un payload que viola el esquema; `crash` sale.
 */
let buf = ""
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8")
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line) as { id: number; params: { event: { payload: Record<string, unknown> } } }
    const p = msg.params.event.payload
    const input = (p.tool_input ?? {}) as { bad?: boolean; crash?: boolean }
    if (input.crash) process.exit(1)
    const text = ((p.tool_response as { content?: { text: string }[] })?.content ?? [])[0]?.text ?? "[]"
    const charges = JSON.parse(text) as { amount: number; currency: string }[]
    const payload = input.bad
      ? { count: "muchos", total: 0, currency: "MXN" }
      : {
          count: charges.length,
          total: charges.reduce((a, c) => a + c.amount, 0),
          currency: charges[0]?.currency ?? "MXN",
        }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { events: [{ key: "charges", kind: "payments.charges.listed", coverage: "observed", payload }] } })}\n`,
    )
  }
})
