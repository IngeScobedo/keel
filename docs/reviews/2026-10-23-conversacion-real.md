# Conversación con un run de Claude real · 2026-10-23

Prueba real de ADR-0019 §3, hecha con permiso del humano y su suscripción:
Claude Code 2.1.304, `haiku`, WSL2 y un daemon aislado. Un script hizo de humano
por el protocolo: arrancó un run `plan`, le escribió a mitad con `runs.message`
y después lo continuó con `runs.continue`.

## Resultado

| Paso                   | Observado                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mensaje a mitad de run | Llegó después del primer `Glob`. Claude Code **lo metió en el turno en curso** (un segundo `UserPromptSubmit`) y respondió con **un solo `result`** para los dos mensajes.                 |
| Primer intento         | El run quedó en `running`. La cola de entrada esperaba un `result` por mensaje y nunca se cerró. Se canceló y se corrigió: la entrada se cierra con el primer `result` sin nada pendiente. |
| Con la corrección      | `completed`, 0.00097 USD `estimated`. La respuesta contesta las dos peticiones: el resumen y el número de líneas.                                                                          |
| Continuar              | El run hijo retomó la misma sesión (`resumed_session` igual a su `session_id`). El agente respondió «2», lo que había dicho antes, por 0.00124 USD `estimated`.                            |

## Lo que esto no prueba

- **Codex real.** `turn/steer` y `thread/resume` sólo están probados con el
  doble del app-server.
- **Continuar un `execute` en su worktree con un proveedor real.** Con dobles sí
  está probado.
- **Si `total_cost_usd` acumula entre turnos de la misma consulta.** En esta
  corrida sólo hubo un `result` por consulta.
