/** ADR-0032: la clase de un comando SSH, decidida por código antes de correrlo. */
import { describe, expect, test } from "bun:test"
import { classifySshCommand, sshProgramsCovered } from "../src/index.ts"

const cls = (c: string) => classifySshCommand(c).class

describe("ADR-0032: clase de un comando SSH", () => {
  test("lecturas: cada segmento de la tubería lee", () => {
    for (const c of [
      "docker ps",
      "ls -la /srv",
      "df -h",
      "systemctl status nginx",
      "docker logs --tail 50 web | grep -i error",
      "journalctl -u keel -n 100 --no-pager",
      "pm2 logs --nostream",
      "free -m && uptime",
      "cat /etc/os-release 2>/dev/null",
      "docker compose ps",
      "find /var/log -name '*.gz'",
      "ps aux | grep '[n]ode'",
    ])
      expect([c, cls(c)]).toEqual([c, "read"])
  })

  test("servicio: cambia un servicio o no se reconoce; lo desconocido nunca es lectura", () => {
    for (const c of [
      "systemctl restart nginx",
      "docker compose up -d",
      "git pull",
      "nginx -s reload",
      "pm2 restart api",
      "cat log > /tmp/x",
      "ls | tee out.txt",
      "sudo docker ps",
      "mi-script.sh",
      "find . -name x -exec cat {} +",
      "pm2 logs",
      "echo $(hostname)",
      "$CMD --version",
    ])
      expect([c, cls(c)]).toEqual([c, "service"])
  })

  test("destructivo: borra o deja sin servicio, decidido por su segmento", () => {
    for (const c of [
      "rm -rf /srv/app",
      "rm -r build",
      "mkfs.ext4 /dev/sdb1",
      "dd if=/dev/zero of=/dev/sda",
      "iptables -F",
      "shutdown -h now",
      "sudo reboot",
      "kill -9 1",
      "docker system prune -af",
      "docker compose down -v",
      `psql -c "DROP TABLE users"`,
      `docker exec db psql -U app -c 'truncate orders'`,
      "chmod -R 777 /",
      "chown -R app /etc",
      "echo hola > /dev/sda",
      "echo $(rm -rf /)",
    ])
      expect([c, cls(c)]).toEqual([c, "destructive"])
    const r = classifySshCommand("docker ps && rm -rf /srv/app")
    expect(r).toMatchObject({ class: "destructive", segment: "rm -rf /srv/app" })
  })

  test("lo que no se puede analizar es destructivo", () => {
    expect(classifySshCommand(`echo "sin cerrar`)).toMatchObject({
      class: "destructive",
      reason: expect.stringContaining("no se pudo analizar"),
    })
    expect(cls("cat <<EOF\nhola\nEOF")).toBe("destructive")
  })

  test("comillas: un operador entre comillas no parte el comando", () => {
    expect(cls(`grep "a;rm -rf /" log`)).toBe("read")
    expect(cls(`grep 'x' log; rm -rf /tmp/x`)).toBe("destructive")
  })

  test("una aprobación de la tarea cubre sólo el mismo programa y subcomando", () => {
    const restart = classifySshCommand("systemctl restart nginx")
    expect(restart.programs).toEqual(["systemctl restart"])
    expect(
      sshProgramsCovered(["systemctl restart"], classifySshCommand("systemctl restart api")),
    ).toBe(true)
    expect(
      sshProgramsCovered(["systemctl restart"], classifySshCommand("systemctl stop nginx")),
    ).toBe(false)
    expect(sshProgramsCovered(["systemctl restart"], classifySshCommand("rm -rf /srv"))).toBe(false)
    expect(
      sshProgramsCovered(
        ["systemctl restart"],
        classifySshCommand("git pull && systemctl restart api"),
      ),
    ).toBe(false)
  })
})
