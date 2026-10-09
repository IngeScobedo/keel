/** Referencia para el probe `lag`: la misma escritura grande, en un Worker. */
import { Database } from "bun:sqlite"

declare const self: Worker

self.onmessage = (e: MessageEvent<{ dbPath: string; rows: number }>) => {
  const { dbPath, rows } = e.data
  const db = new Database(dbPath)
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS ev(id INTEGER PRIMARY KEY, seq INTEGER, payload TEXT)",
  )
  const payload = JSON.stringify({ raw: "x".repeat(2000) })
  const t = performance.now()
  const ins = db.prepare("INSERT INTO ev(seq,payload) VALUES (?,?)")
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(i, payload)
  })()
  const ms = performance.now() - t
  db.close()
  self.postMessage(ms)
}
