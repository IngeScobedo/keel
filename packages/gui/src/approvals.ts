import type { Approval } from "./fixtures.js"

/** El TTL se comprueba al confirmar; abrir un modal no concede permiso. */
export function approvalCanResolve(approval: Approval, now: number, demo: boolean) {
  return (
    demo && approval.state === "pending" && approval.expiresAt > now && approval.operation !== null
  )
}
