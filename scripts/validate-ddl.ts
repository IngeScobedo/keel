/**
 * Valida el DDL de referencia (SDD 03) sobre el SQLite que trae Bun (bun:sqlite).
 *
 *   bun scripts/validate-ddl.ts                 # lee los bloques ```sql de docs/sdd/03-*.md
 *   bun scripts/validate-ddl.ts ruta/a/0001.sql # valida un fichero de migración
 *
 * Cada comprobación es una afirmación sobre el contrato SQL (ADR-0004, ADR-0006):
 * guardas, triggers, índices parciales, vistas, FTS5, vec0 y persistencia del
 * outbox al reabrir la base. Sale con código 1 si alguna falla.
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getLoadablePath } from "sqlite-vec"

const arg = process.argv[2]
let relational: string
let vector: string | null = null
if (arg && !arg.endsWith(".md")) {
  relational = readFileSync(arg, "utf8")
  const vecPath = arg.replace(/\.sql$/, ".vec.sql")
  vector = existsSync(vecPath) ? readFileSync(vecPath, "utf8") : null
} else {
  const md = readFileSync(
    arg ?? join(import.meta.dir, "..", "docs/sdd/03-data-model-and-storage.md"),
    "utf8",
  )
  const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  relational = blocks[0] ?? ""
  vector = blocks[1] ?? null
}

const dir = mkdtempSync(join(tmpdir(), "keel-ddl-"))
const dbPath = join(dir, "keel.sqlite")
let db = new Database(dbPath)

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, fn: () => boolean | void) {
  try {
    const r = fn()
    if (r === false) throw new Error("returned false")
    passed++
  } catch (e) {
    failed++
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
function rejects(sql: string, params: unknown[] = []): boolean {
  try {
    db.query(sql).run(...(params as never[]))
    return false
  } catch {
    return true
  }
}
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  db.query(sql).get(...(p as never[])) as T
const T = "2026-10-09T00:00:00.000Z"

// --- esquema ---------------------------------------------------------------
db.exec(relational)
check(
  "sqlite >= 3.44 (ADR-0004)",
  () => String(one<{ v: string }>("select sqlite_version() v").v) >= "3.44",
)
check(
  "journal_mode = wal",
  () => one<{ journal_mode: string }>("pragma journal_mode").journal_mode === "wal",
)
check(
  "foreign_keys = on",
  () => one<{ foreign_keys: number }>("pragma foreign_keys").foreign_keys === 1,
)
check(
  "synchronous = FULL",
  () => one<{ synchronous: number }>("pragma synchronous").synchronous === 2,
)
check(
  "fts5 disponible",
  () =>
    one<{ n: number }>("select count(*) n from sqlite_master where name='research_fts'").n === 1,
)

// --- datos base --------------------------------------------------------------
db.exec(`
INSERT INTO work_spaces(id,name,target_id,root_path) VALUES('w1','ws','t1','/r');
INSERT INTO projects(id,workspace_id,name,slug) VALUES('p1','w1','p1','p1'),('p2','w1','p2','p2');
INSERT INTO project_repos(id,project_id,alias,repo_url,default_branch,local_path,is_primary) VALUES
 ('be','p1','backend','git@x/be','main','/r/be',1),('fe','p1','frontend','git@x/fe','main','/r/fe',0),('other','p2','backend','git@x/o','main','/r/o',1);
INSERT INTO work_items(id,project_id,repo_id,display_id,title,kind,source) VALUES
 ('wi1','p1','be','K-1','t1','feature','human'),('wi2','p1','fe','K-2','t2','feature','human'),('wi3','p1','be','K-3','t3','bug','agent');
`)
check("un solo repo principal por proyecto", () =>
  rejects(
    "INSERT INTO project_repos(id,project_id,alias,repo_url,local_path,is_primary) VALUES('be2','p1','backend2','u','/r/be2',1)",
  ),
)
check("frontera de proyecto: work_item con repo de otro proyecto", () =>
  rejects(
    "INSERT INTO work_items(id,project_id,repo_id,display_id,title,kind,source) VALUES('wiX','p1','other','K-X','t','feature','human')",
  ),
)
check("display_id único por proyecto", () =>
  rejects(
    "INSERT INTO work_items(id,project_id,display_id,title,kind,source) VALUES('wiY','p1','K-1','t','feature','human')",
  ),
)
check("json_valid en board_status_config", () =>
  rejects("UPDATE projects SET board_status_config='{nope' WHERE id='p1'"),
)
check("lifecycle fuera del CHECK rechazado", () =>
  rejects("UPDATE work_items SET lifecycle='weird' WHERE id='wi1'"),
)
check("dependencia a sí misma rechazada", () =>
  rejects(
    "INSERT INTO work_item_dependencies(project_id,waiting_work_item_id,blocking_work_item_id,required_lifecycle) VALUES('p1','wi1','wi1','done')",
  ),
)

// --- dedupe activo ------------------------------------------------------------
db.exec("UPDATE work_items SET dedupe_key='sig1' WHERE id='wi3'")
check("dedupe: segunda tarjeta activa con la misma firma rechazada", () =>
  rejects(
    "INSERT INTO work_items(id,project_id,display_id,title,kind,source,dedupe_key) VALUES('wi4','p1','K-4','t','bug','agent','sig1')",
  ),
)
db.exec("UPDATE work_items SET lifecycle='done' WHERE id='wi3'")
check(
  "dedupe: permitida cuando la anterior está done",
  () =>
    !rejects(
      "INSERT INTO work_items(id,project_id,display_id,title,kind,source,dedupe_key) VALUES('wi4','p1','K-4','t','bug','agent','sig1')",
    ),
)

// --- runs: estados, purpose, run vivo (ADR-0006) ---------------------------------
db.exec(
  "INSERT INTO runs(id,project_id,work_item_id,purpose,status) VALUES('r1','p1','wi1','plan','waiting_human')",
)
check("idx_live_run: segundo run vivo con el primero en waiting_human rechazado", () =>
  rejects("INSERT INTO runs(id,project_id,work_item_id,status) VALUES('r2','p1','wi1','queued')"),
)
check("idx_live_run: paused cuenta como vivo", () => {
  db.exec("UPDATE runs SET status='paused' WHERE id='r1'")
  return rejects(
    "INSERT INTO runs(id,project_id,work_item_id,status) VALUES('r2','p1','wi1','queued')",
  )
})
db.exec("UPDATE runs SET status='interrupted', end_reason='rate_limit' WHERE id='r1'")
check(
  "interrupted es terminal: permite un run nuevo",
  () =>
    !rejects(
      "INSERT INTO runs(id,project_id,work_item_id,status) VALUES('r2','p1','wi1','running')",
    ),
)
check("runs.purpose inválido rechazado", () =>
  rejects("INSERT INTO runs(id,project_id,work_item_id,purpose) VALUES('r3','p1','wi2','x')"),
)
check("runs.cost_kind inválido rechazado", () =>
  rejects("UPDATE runs SET cost_kind='billed' WHERE id='r2'"),
)
check("run de otro proyecto que su work_item rechazado", () =>
  rejects("INSERT INTO runs(id,project_id,work_item_id) VALUES('r9','p2','wi2')"),
)

// --- nodos de ejecución --------------------------------------------------------
db.exec(`
INSERT INTO workflow_nodes(id,run_id,title) VALUES('wf1','r2','plan');
INSERT INTO agent_instances(id,run_id,provider,session_id,classification,first_seen,last_seen) VALUES('a1','r2','claude','s1','root','${T}','${T}');
INSERT INTO agent_instances(id,run_id,provider,session_id,external_agent_id,parent_agent_id,parent_source,classification,first_seen,last_seen) VALUES('a2','r2','claude','s1','sub1','a1','sdk','worker','${T}','${T}');
`)
check(
  "parent_source 'sdk' aceptado (ADR-0002 §4)",
  () =>
    one<{ n: number }>("select count(*) n from agent_instances where parent_source='sdk'").n === 1,
)
check("agente con padre agente Y padre workflow rechazado", () =>
  rejects(
    `INSERT INTO agent_instances(id,run_id,provider,session_id,parent_agent_id,parent_workflow_id,classification,first_seen,last_seen) VALUES('a3','r2','claude','s1','a1','wf1','worker','${T}','${T}')`,
  ),
)
check("workflow_nodes.state default pending y CHECK", () => {
  const st = one<{ state: string }>("select state from workflow_nodes where id='wf1'").state
  return st === "pending" && rejects("UPDATE workflow_nodes SET state='done' WHERE id='wf1'")
})
check("tool_calls.state: 'done' rechazado, 'succeeded' aceptado", () => {
  const bad = rejects(
    `INSERT INTO tool_calls(id,run_id,agent_id,tool_use_id,tool_name,label,state,started_at) VALUES('t1','r2','a1','tu1','Bash','x','done','${T}')`,
  )
  const ok = !rejects(
    `INSERT INTO tool_calls(id,run_id,agent_id,tool_use_id,tool_name,label,state,started_at) VALUES('t1','r2','a1','tu1','Bash','x','succeeded','${T}')`,
  )
  return bad && ok
})
check("tool_calls.label vacío rechazado", () =>
  rejects(
    `INSERT INTO tool_calls(id,run_id,agent_id,tool_use_id,tool_name,label,state,started_at) VALUES('t2','r2','a1','tu2','Bash','','pending','${T}')`,
  ),
)

// --- eventos y actividades append-only ----------------------------------------------
db.exec(
  `INSERT INTO events(id,project_id,run_id,source,source_event_key,fidelity,adapter_version,kind,payload_json) VALUES('e1','p1','r2','sdk','k1','full','0.1','PreToolUse','{}')`,
)
check(
  "events: kind libre (sin CHECK)",
  () =>
    !rejects(
      `INSERT INTO events(id,project_id,run_id,source,source_event_key,fidelity,adapter_version,kind,payload_json) VALUES('e2','p1','r2','sdk','k2','full','0.1','SomethingNew','{}')`,
    ),
)
check("events: dedupe por (project, source, source_event_key)", () =>
  rejects(
    `INSERT INTO events(id,project_id,run_id,source,source_event_key,fidelity,adapter_version,kind,payload_json) VALUES('e3','p1','r2','sdk','k1','full','0.1','X','{}')`,
  ),
)
check("events: UPDATE rechazado por trigger", () =>
  rejects("UPDATE events SET kind='Y' WHERE id='e1'"),
)
check("events: DELETE rechazado por trigger", () => rejects("DELETE FROM events WHERE id='e1'"))
check("events: payload_json inválido rechazado", () =>
  rejects(
    `INSERT INTO events(id,project_id,source,source_event_key,fidelity,adapter_version,kind,payload_json) VALUES('e4','p1','sdk','k4','full','0.1','X','{')`,
  ),
)
db.exec(
  "INSERT INTO activities(id,project_id,work_item_id,actor_kind,actor_id,verb,details_json,dedupe_key) VALUES('ac1','p1','wi1','human','u1','note','{}','d1')",
)
check(
  "activities: append-only y dedupe",
  () =>
    rejects("UPDATE activities SET verb='x' WHERE id='ac1'") &&
    rejects(
      "INSERT INTO activities(id,project_id,work_item_id,actor_kind,actor_id,verb,details_json,dedupe_key) VALUES('ac2','p1','wi1','human','u1','note','{}','d1')",
    ),
)
check("command_receipts: clave por (project, actor, idempotency_key)", () => {
  db.exec(
    "INSERT INTO command_receipts(project_id,actor_id,idempotency_key,request_hash,result_json) VALUES('p1','u1','ik1','h1','{}')",
  )
  return rejects(
    "INSERT INTO command_receipts(project_id,actor_id,idempotency_key,request_hash,result_json) VALUES('p1','u1','ik1','h2','{}')",
  )
})

// --- contratos -------------------------------------------------------------------
db.exec(
  "INSERT INTO evidence(id,project_id,run_id,kind,artifact_ref,sha256,metadata_json) VALUES('ev1','p1','r2','test_log','art://1','abc','{}')",
)
check("contrato v2 sin v1 rechazado", () =>
  rejects(
    "INSERT INTO api_contracts(id,project_id,producer_repo_id,name,version,schema_type,schema_content,schema_sha256,compatibility) VALUES('c2','p1','be','auth',2,'openapi','x','h','compatible')",
  ),
)
check("contrato v1 con compatibility != initial rechazado", () =>
  rejects(
    "INSERT INTO api_contracts(id,project_id,producer_repo_id,name,version,schema_type,schema_content,schema_sha256,compatibility) VALUES('c1','p1','be','auth',1,'openapi','x','h','compatible')",
  ),
)
db.exec(
  "INSERT INTO api_contracts(id,project_id,producer_repo_id,name,version,schema_type,schema_content,schema_sha256,compatibility) VALUES('c1','p1','be','auth',1,'openapi','x','h1','initial')",
)
check(
  "contract_created: evento draft seq 1 y outbox contract_updated",
  () =>
    one<{ state: string }>(
      "select state from contract_state_events where contract_id='c1' and seq=1",
    ).state === "draft" &&
    one<{ n: number }>(
      "select count(*) n from outbox where event_type='contract_updated' and aggregate_id='c1'",
    ).n === 1,
)
check(
  "contratos inmutables: UPDATE y DELETE rechazados",
  () =>
    rejects("UPDATE api_contracts SET schema_content='y' WHERE id='c1'") &&
    rejects("DELETE FROM api_contracts WHERE id='c1'"),
)
check("draft -> implemented rechazado", () =>
  rejects(
    "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id,evidence_id) VALUES('c1','p1',2,'implemented','u1','ev1')",
  ),
)
check("ready_for_mock sin evidencia rechazado", () =>
  rejects(
    "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id) VALUES('c1','p1',2,'ready_for_mock','u1')",
  ),
)
check("seq no secuencial rechazado", () =>
  rejects(
    "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id,evidence_id) VALUES('c1','p1',3,'ready_for_mock','u1','ev1')",
  ),
)
// dependencia ANTES de ready: bloqueada
db.exec(
  "INSERT INTO task_contract_dependencies(id,project_id,waiting_work_item_id,blocking_contract_id) VALUES('d1','p1','wi2','c1')",
)
check(
  "gate: draft no satisface",
  () =>
    one<{ s: number }>("select is_satisfied s from task_contract_gate_status where id='d1'").s ===
    0,
)
check(
  "dependencia nueva encola work_item_gate_recheck",
  () =>
    one<{ n: number }>(
      "select count(*) n from outbox where event_type='work_item_gate_recheck' and dedupe_key='contract-dependency:d1'",
    ).n === 1,
)
db.exec(
  "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id,evidence_id) VALUES('c1','p1',2,'ready_for_mock','u1','ev1')",
)
check(
  "gate: ready_for_mock satisface required ready_for_mock",
  () =>
    one<{ s: number }>("select is_satisfied s from task_contract_gate_status where id='d1'").s ===
    1,
)
check(
  "cada estado nuevo encola contract_gate_recheck (seq 1 y 2)",
  () =>
    one<{ n: number }>(
      "select count(*) n from outbox where event_type='contract_gate_recheck' and dedupe_key in ('contract-state:c1:1','contract-state:c1:2')",
    ).n === 2,
)
// dependencia DESPUÉS de ready: satisfecha de inmediato
db.exec(
  "INSERT INTO task_contract_dependencies(id,project_id,waiting_work_item_id,blocking_contract_id,required_state) VALUES('d2','p1','wi3','c1','implemented')",
)
check(
  "gate: required implemented no satisfecho por ready_for_mock",
  () =>
    one<{ s: number }>("select is_satisfied s from task_contract_gate_status where id='d2'").s ===
    0,
)
db.exec(
  "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id,evidence_id) VALUES('c1','p1',3,'implemented','u1','ev1')",
)
check(
  "gate: implemented satisface ambas dependencias",
  () =>
    one<{ n: number }>(
      "select count(*) n from task_contract_gate_status where blocking_contract_id='c1' and is_satisfied=1",
    ).n === 2,
)
check("estado de contrato inmutable", () =>
  rejects("UPDATE contract_state_events SET state='draft' WHERE contract_id='c1' AND seq=1"),
)
check(
  "api_contract_status proyecta el último estado",
  () =>
    one<{ state: string }>("select state from api_contract_status where id='c1'").state ===
    "implemented",
)
db.exec(
  "INSERT INTO api_contracts(id,project_id,producer_repo_id,name,version,previous_contract_id,schema_type,schema_content,schema_sha256,compatibility) VALUES('c2','p1','be','auth',2,'c1','openapi','y','h2','breaking')",
)
check("v2 con previous v1 aceptado; v3 saltando rechazado", () =>
  rejects(
    "INSERT INTO api_contracts(id,project_id,producer_repo_id,name,version,previous_contract_id,schema_type,schema_content,schema_sha256,compatibility) VALUES('c4','p1','be','auth',4,'c2','openapi','z','h4','compatible')",
  ),
)
db.exec(
  "INSERT INTO contract_reconciliations(id,project_id,consumer_work_item_id,previous_contract_id,replacement_contract_id,reconciliation_work_item_id) VALUES('rc1','p1','wi2','c1','c2','wi4')",
)
check("reconciliación única por (consumer, replacement)", () =>
  rejects(
    "INSERT INTO contract_reconciliations(id,project_id,consumer_work_item_id,previous_contract_id,replacement_contract_id,reconciliation_work_item_id) VALUES('rc2','p1','wi2','c1','c2','wi4')",
  ),
)
db.exec(
  "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id) VALUES('c1','p1',4,'deprecated','u1')",
)
check(
  "deprecated no satisface",
  () =>
    one<{ n: number }>(
      "select count(*) n from task_contract_gate_status where blocking_contract_id='c1' and is_satisfied=1",
    ).n === 0,
)
check("deprecated -> cualquier estado rechazado", () =>
  rejects(
    "INSERT INTO contract_state_events(contract_id,project_id,seq,state,actor_id,evidence_id) VALUES('c1','p1',5,'implemented','u1','ev1')",
  ),
)

// --- research: FTS, claims, lanes ------------------------------------------------------
db.exec(
  `INSERT INTO shared_researches(id,project_id,origin_work_item_id,origin_repo_id,target_scope,incident_key,snapshot_hash,snapshot_manifest_json,summary,findings_md,sources_json,created_by_agent) VALUES('rs1','p1','wi1','be','auth','inc1','snap1','{}','Login callback expects code','OAuth callback mismatch found in src/auth','[]','a1')`,
)
check(
  "FTS: insert sincroniza",
  () =>
    one<{ n: number }>("select count(*) n from research_fts where research_fts match 'callback'")
      .n === 1,
)
db.exec("UPDATE shared_researches SET findings_md='Token refresh retry' WHERE id='rs1'")
check(
  "FTS: update sincroniza",
  () =>
    one<{ n: number }>("select count(*) n from research_fts where research_fts match 'refresh'")
      .n === 1 &&
    one<{ n: number }>("select count(*) n from research_fts where research_fts match 'mismatch'")
      .n === 0,
)
check("research_claims: lease único por (project, scope, incident, snapshot)", () => {
  db.exec(
    "INSERT INTO research_claims(project_id,target_scope,incident_key,snapshot_hash,owner_run_id,fencing_token,lease_expires_at) VALUES('p1','auth','inc1','snap1','r2',1,'2027')",
  )
  return rejects(
    "INSERT INTO research_claims(project_id,target_scope,incident_key,snapshot_hash,owner_run_id,fencing_token,lease_expires_at) VALUES('p1','auth','inc1','snap1','r2',2,'2027')",
  )
})
check("cross_findings: fingerprint único por proyecto", () => {
  db.exec(
    "INSERT INTO cross_findings(id,project_id,source_run_id,target_repo_id,target_work_item_id,severity,fingerprint,details_json) VALUES('cf1','p1','r2','be','wi3','high','fp1','{}')",
  )
  return rejects(
    "INSERT INTO cross_findings(id,project_id,source_run_id,target_repo_id,target_work_item_id,severity,fingerprint,details_json) VALUES('cf2','p1','r2','be','wi3','high','fp1','{}')",
  )
})
check("lanes y run_worktrees con FKs compuestas", () => {
  db.exec(
    "INSERT INTO lanes(id,project_id,run_id,project_repo_id,name,file_scopes_json) VALUES('l1','p1','r2','be','api','[\"src/api/**\"]')",
  )
  db.exec(
    "INSERT INTO run_worktrees(id,project_id,run_id,project_repo_id,lane_id,slot,worktree_path,base_sha,branch_name) VALUES('wt1','p1','r2','be','l1','l1','/wt/1','sha1','keel/wi1/r2/l1')",
  )
  return rejects(
    "INSERT INTO run_worktrees(id,project_id,run_id,project_repo_id,lane_id,slot,worktree_path,base_sha,branch_name) VALUES('wt2','p1','r2','fe','l1','l1','/wt/2','sha1','keel/x')",
  )
})
check("work_item_blocks: una causa por (item, kind, reason)", () => {
  db.exec(
    "INSERT INTO work_item_blocks(id,work_item_id,kind,reason_key,details_json) VALUES('b1','wi2','dependency','c1','{}')",
  )
  return rejects(
    "INSERT INTO work_item_blocks(id,work_item_id,kind,reason_key,details_json) VALUES('b2','wi2','dependency','c1','{}')",
  )
})
check(
  "approval_requests y permission_grants: CHECKs",
  () =>
    rejects(
      "INSERT INTO permission_grants(id,project_id,policy,scope_json,granted_by) VALUES('g1','p1','always','{}','u1')",
    ) &&
    rejects(
      "INSERT INTO approval_requests(id,project_id,run_id,operation_hash,operation_json,state) VALUES('ap1','p1','r2','h','{}','maybe')",
    ),
)

// --- vec0 ---------------------------------------------------------------------------
let vecStatus = "no ejecutado"
if (vector) {
  try {
    db.loadExtension(getLoadablePath())
    db.exec(vector)
    db.exec(
      "INSERT INTO research_vectors(research_id,project_id,embedding) VALUES('rs1','p1', ?)".replace(
        "?",
        `'[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]'`,
      ),
    )
    db.exec(
      `INSERT INTO research_vectors(research_id,project_id,embedding) VALUES('rs-other','p2','[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]')`,
    )
    const q = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 0.9 : 0)).join(",")}]`
    check("vec0: KNN particionado por proyecto", () => {
      const rows = db
        .query(
          "select research_id from research_vectors where project_id='p1' and embedding match ? and k=5",
        )
        .all(q) as { research_id: string }[]
      return rows.length === 1 && rows[0]?.research_id === "rs1"
    })
    check("vec0: dimensión incorrecta rechazada", () =>
      rejects(
        "INSERT INTO research_vectors(research_id,project_id,embedding) VALUES('bad','p1','[1,2,3]')",
      ),
    )
    vecStatus = `ok (${one<{ v: string }>("select vec_version() v").v})`
  } catch (e) {
    vecStatus = `no cargó: ${e instanceof Error ? e.message : String(e)}`
    failed++
    failures.push(`vec0: ${vecStatus}`)
  }
}

// --- persistencia y cierre ------------------------------------------------------------
const pendingBefore = one<{ n: number }>(
  "select count(*) n from outbox where delivered_at is null",
).n
db.close()
db = new Database(dbPath)
check(
  "outbox persiste al reabrir (pendientes intactos)",
  () =>
    one<{ n: number }>("select count(*) n from outbox where delivered_at is null").n ===
      pendingBefore && pendingBefore > 0,
)
check("foreign_key_check limpio", () => db.query("pragma foreign_key_check").all().length === 0)
check(
  "integrity_check ok",
  () => one<{ integrity_check: string }>("pragma integrity_check").integrity_check === "ok",
)
db.close()
rmSync(dir, { recursive: true, force: true })

console.log(
  `DDL: ${passed} comprobaciones en verde, ${failed} fallidas · SQLite ${Database.prototype.constructor.name ? new Database(":memory:").query("select sqlite_version() v").get()?.["v" as never] : "?"} (bun:sqlite) · vec0: ${vecStatus}`,
)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failed === 0 ? 0 : 1)
