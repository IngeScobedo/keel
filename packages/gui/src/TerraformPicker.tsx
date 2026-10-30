/**
 * El alta de una conexión de Terraform sin escribir rutas: Keel encuentra las carpetas
 * con `.tf` del proyecto y el humano elige. Un entorno puede ser una carpeta propia
 * (`terraform/environments/stage`), un archivo de variables (`stage.tfvars`) o un
 * workspace; los tres se guardan en la conexión.
 */
import type { Methods } from "@keel/core"
import { FolderOpen, FolderTree, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { hasNativeShell } from "./client.js"
import { Select } from "./ui/index.js"
import { Button, Hint } from "./ui.js"
import type { useWorkspace } from "./useWorkspace.js"
import "./TerraformPicker.css"

type Call = ReturnType<typeof useWorkspace>["call"]
type Env = "prod" | "staging" | "dev"
type Found = ReturnType<(typeof Methods)["terraform.discover"]["result"]["parse"]>
type Dir = Found["dirs"][number]

/** Lo que el alta guarda en `config` y lo que propone de nombre y entorno. */
export type TerraformTarget = {
  config: {
    dir: string
    var_file?: string
    workspace?: string
    var_secrets?: Record<string, string>
  }
  name: string
  environment: Env | null
}

const ENV_WORD: Record<Env, string> = { prod: "production", staging: "stage", dev: "dev" }

export function TerraformPicker({
  call,
  projectRoot,
  initialDir = "",
  onChange,
}: {
  call: Call
  projectRoot: string
  /** La carpeta que propuso el agente (ADR-0025 §6), elegida de entrada si existe. */
  initialDir?: string
  onChange: (t: TerraformTarget | null) => void
}) {
  const [found, setFound] = useState<Found | null>(null)
  const [dirs, setDirs] = useState<Dir[]>([])
  const [pick, setPick] = useState(0)
  const [varFile, setVarFile] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [path, setPath] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    call("terraform.discover", {})
      .then((r) => {
        if (!alive) return
        setFound(r)
        setDirs(r.dirs)
        const want = initialDir.replace(/^\.\//, "").replace(/\/$/, "")
        const i = r.dirs.findIndex((d) => d.dir === want || `${r.root}/${d.dir}` === want)
        if (i > 0) setPick(i)
      })
      .catch((e) => {
        if (!alive) return
        setError(discoverError(e))
        setDirs([])
      })
    return () => {
      alive = false
    }
  }, [call, initialDir])
  const current = dirs[pick] ?? null
  // Al cambiar de carpeta: sin tfvars ni workspace elegidos, y sus secretos por llenar.
  useEffect(() => {
    if (!current) return
    setVarFile("")
    setWorkspace("")
    setRefs({})
  }, [current])
  useEffect(() => {
    if (!current || current.module) {
      onChange(null)
      return
    }
    const tfvars = current.tfvars.find((t) => t.file === varFile)
    // El entorno lo dice la carpeta; si no, el tfvars o el workspace elegidos.
    const environment =
      current.suggested_environment ??
      tfvars?.environment ??
      (workspace ? envOf(workspace) : null) ??
      null
    const suffix =
      !current.suggested_environment && (tfvars || workspace)
        ? `-${workspace || (environment ? ENV_WORD[environment] : (varFile.split(".")[0] ?? ""))}`
        : ""
    const secrets = Object.fromEntries(Object.entries(refs).filter(([, v]) => v.trim()))
    onChange({
      config: {
        dir: current.dir,
        ...(varFile ? { var_file: varFile } : {}),
        ...(workspace ? { workspace } : {}),
        ...(Object.keys(secrets).length ? { var_secrets: secrets } : {}),
      },
      name: `${current.suggested_name}${suffix}`,
      environment,
    })
  }, [current, varFile, workspace, refs, onChange])
  async function inspect(dir: string) {
    setError("")
    try {
      const r = await call("terraform.discover", { path: dir })
      const one = r.dirs[0]
      if (!one) return
      setDirs((o) => [one, ...o.filter((x) => x.dir !== one.dir)])
      setPick(0)
    } catch (e) {
      setError(discoverError(e))
    }
  }
  async function chooseDir() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const root = found?.root || projectRoot
      const chosen = await open({
        multiple: false,
        directory: true,
        title: "Elegir la carpeta de Terraform",
        ...(root ? { defaultPath: root } : {}),
      })
      if (typeof chosen === "string") await inspect(chosen)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const secretVars = current?.variables.filter((v) => v.sensitive && !v.has_default) ?? []
  return (
    <div className="ansible-picker tf-picker" data-testid="terraform-picker">
      <span className="label">Carpeta de Terraform</span>
      {found && (
        <p className={`tf-binary ${found.terraform.version ? "muted" : "warn"}`}>
          {found.terraform.version ? (
            <>terraform {found.terraform.version} en el daemon</>
          ) : (
            <>
              <TriangleAlert size={13} /> {found.terraform.error}
            </>
          )}
        </p>
      )}
      {found === null && !error && (
        <p className="muted">Buscando carpetas de Terraform en el proyecto…</p>
      )}
      {found && dirs.length === 0 && (
        <Hint>No encontré archivos .tf en el proyecto. Elige la carpeta.</Hint>
      )}
      <fieldset className="ansible-playbooks" aria-label="Carpetas de Terraform encontradas">
        {dirs.map((d, i) => (
          <label
            key={d.dir}
            className="ansible-playbook"
            data-module={d.module || undefined}
            title={d.module ? "Un módulo: se usa desde otra carpeta, no se aplica solo" : undefined}
          >
            <input
              type="radio"
              name="terraform-dir"
              checked={i === pick}
              disabled={d.module}
              onChange={() => setPick(i)}
            />
            <FolderTree size={15} />
            <span className="mono">{d.dir}</span>
            <small>
              {d.module
                ? "módulo"
                : [
                    d.suggested_environment,
                    d.providers.join(", ") || null,
                    `estado ${d.backend ?? "local"}`,
                    `${d.variables.length} variables`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </small>
          </label>
        ))}
      </fieldset>
      <div className="ansible-file">
        {hasNativeShell() ? (
          <Button icon={FolderOpen} onClick={() => void chooseDir()}>
            Elegir otra carpeta…
          </Button>
        ) : (
          <>
            <input
              aria-label="Ruta de la carpeta de Terraform"
              className="mono"
              placeholder="infra/terraform"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button disabled={!path.trim()} onClick={() => void inspect(path.trim())}>
              Usar
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {current && !current.module && (
        <div className="tf-env">
          {current.tfvars.length > 0 && (
            <label>
              Archivo de variables
              <Select
                aria-label="Archivo de variables"
                value={varFile}
                onChange={setVarFile}
                options={[
                  { value: "", label: "Ninguno" },
                  ...current.tfvars.map((t) => ({
                    value: t.file,
                    label: t.environment ? `${t.file} · ${t.environment}` : t.file,
                  })),
                ]}
              />
            </label>
          )}
          {current.workspaces.length > 0 ? (
            <label>
              Workspace
              <Select
                aria-label="Workspace"
                value={workspace}
                onChange={setWorkspace}
                options={[
                  { value: "", label: "default" },
                  ...current.workspaces.map((w) => ({ value: w, label: w })),
                ]}
              />
            </label>
          ) : (
            <label>
              Workspace
              <input
                aria-label="Workspace"
                className="mono"
                placeholder="default"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value.trim())}
              />
            </label>
          )}
        </div>
      )}
      {current && !current.module && (
        <Hint>
          {current.suggested_environment
            ? `El entorno sale de la carpeta (${current.suggested_environment}).`
            : current.tfvars.length || current.workspaces.length
              ? "Una conexión por entorno: elige su archivo de variables o su workspace."
              : "Sin entornos en esta carpeta: la conexión usa el workspace default."}
          {current.initialized ? "" : " Keel corre terraform init en el primer plan."}
        </Hint>
      )}
      {secretVars.length > 0 && (
        <>
          <span className="label">Variables sensibles</span>
          <p className="muted">
            Keel las pasa como TF_VAR desde su referencia; ni el agente ni el plan las ven.
          </p>
          {secretVars.map((v) => (
            <label key={v.name} className="tf-secret">
              <span className="mono">{v.name}</span>
              <input
                aria-label={`Referencia de ${v.name}`}
                className="mono"
                placeholder="env:NOMBRE · keychain:servicio/cuenta · op://…"
                value={refs[v.name] ?? ""}
                onChange={(e) => setRefs((o) => ({ ...o, [v.name]: e.target.value }))}
              />
            </label>
          ))}
        </>
      )}
    </div>
  )
}

function envOf(word: string): Env | null {
  if (/^(prod|production|prd)$/i.test(word)) return "prod"
  if (/^(staging|stage|stg)$/i.test(word)) return "staging"
  if (/^(dev|development|sandbox)$/i.test(word)) return "dev"
  return null
}

function discoverError(e: unknown): string {
  if ((e as { rpc?: { code?: number } }).rpc?.code === -32601)
    return "El daemon corre una versión anterior de Keel y no sabe buscar carpetas de Terraform: reinícialo con «Daemon desactualizado», arriba."
  return e instanceof Error ? e.message : String(e)
}
