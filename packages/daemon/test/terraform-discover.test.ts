/**
 * Las carpetas de Terraform del proyecto, sin escribir rutas: un entorno por carpeta
 * (`terraform/environments/stage`), un tfvars por entorno o workspaces locales.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverTerraform } from "../src/resources/terraform-discover.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "keel-tf-"))
  dirs.push(root)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

const ENV_MAIN = `terraform {
  # backend "gcs" {} comentado no cuenta
  backend "s3" {
    bucket = "estado"
  }
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    random = { source = "hashicorp/random" }
  }
}
module "red" {
  source = "../../modules/vpc"
}
`
const ENV_VARS = `variable "db_password" {
  type      = string
  sensitive = true
}
variable "region" {
  default = "us-east-1"
}
`

describe("terraform.discover", () => {
  test("un entorno por carpeta: stage y production, y el módulo compartido al final", () => {
    const root = project({
      "terraform/environments/stage/main.tf": ENV_MAIN,
      "terraform/environments/stage/variables.tf": ENV_VARS,
      "terraform/environments/production/main.tf": ENV_MAIN,
      "terraform/environments/production/variables.tf": ENV_VARS,
      "terraform/modules/vpc/main.tf": 'variable "cidr" {}\nresource "aws_vpc" "x" {}\n',
      "node_modules/pkg/main.tf": "ignorado",
    })
    const found = discoverTerraform(root)
    expect(found.map((d) => [d.dir, d.suggested_environment, d.suggested_name, d.module])).toEqual([
      ["terraform/environments/production", "prod", "terraform-production", false],
      ["terraform/environments/stage", "staging", "terraform-stage", false],
      ["terraform/modules/vpc", null, "vpc", true],
    ])
    expect(found[1]).toMatchObject({
      files: 2,
      providers: ["aws", "random"],
      backend: "s3",
      variables: [
        { name: "db_password", sensitive: true, has_default: false },
        { name: "region", sensitive: false, has_default: true },
      ],
      initialized: false,
    })
  })

  test("una carpeta con un tfvars por entorno y workspaces locales", () => {
    const root = project({
      "infra/terraform/main.tf": 'provider "google" {}\n',
      "infra/terraform/stage.tfvars": 'project = "tienda-stage"\n',
      "infra/terraform/production.tfvars": 'project = "tienda"\n',
      "infra/terraform/terraform.tfstate.d/stage/terraform.tfstate": "{}",
      "infra/terraform/terraform.tfstate.d/production/terraform.tfstate": "{}",
    })
    const [one] = discoverTerraform(root)
    expect(one).toMatchObject({
      dir: "infra/terraform",
      suggested_name: "infra-terraform",
      suggested_environment: null,
      providers: ["google"],
      backend: null,
      tfvars: [
        { file: "production.tfvars", environment: "prod" },
        { file: "stage.tfvars", environment: "staging" },
      ],
      workspaces: ["production", "stage"],
    })
  })
})
