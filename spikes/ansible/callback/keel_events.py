# Callback de Keel para Ansible (spike de ADR-0031): un JSON por línea con cada
# tarea y host, al archivo de KEEL_ANSIBLE_EVENTS. Keel lo lee en vivo; nunca
# incluye `result` completo (puede traer secretos): sólo estado, host, tarea y
# un mensaje corto de error.
import json
import os
import time

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
name: keel_events
type: aggregate
short_description: eventos de Ansible para Keel, NDJSON
"""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "keel_events"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self):
        super().__init__()
        self._out = open(os.environ["KEEL_ANSIBLE_EVENTS"], "a", buffering=1)

    def _emit(self, kind, **kw):
        kw.update(kind=kind, at=time.time())
        self._out.write(json.dumps(kw, ensure_ascii=False) + "\n")

    def v2_playbook_on_play_start(self, play):
        self._emit("play", name=play.get_name())

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._emit("task", name=task.get_name(), action=task.action)

    def _result(self, status, result):
        msg = result._result.get("msg") if status in ("failed", "unreachable") else None
        self._emit(
            "result",
            status=status,
            host=result._host.get_name(),
            task=result._task.get_name(),
            changed=bool(result._result.get("changed")),
            msg=str(msg)[:500] if msg else None,
        )

    def v2_runner_on_ok(self, result):
        self._result("changed" if result._result.get("changed") else "ok", result)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._result("ignored" if ignore_errors else "failed", result)

    def v2_runner_on_skipped(self, result):
        self._result("skipped", result)

    def v2_runner_on_unreachable(self, result):
        self._result("unreachable", result)

    def v2_playbook_on_stats(self, stats):
        hosts = {h: stats.summarize(h) for h in sorted(stats.processed.keys())}
        self._emit("recap", hosts=hosts)
