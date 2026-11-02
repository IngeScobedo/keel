/**
 * Lo que el humano ya tiene a la vista fuera de la página de una tarea: las subtareas
 * del lote en vivo de la conversación y la tarea abierta como panel. Un aviso sobre
 * ellas sobra (canvas GUI · 04: «ningún cambio roba el foco»), porque su tarjeta ya dice
 * «espera tu decisión».
 */
let visible: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

export function setVisibleTasks(ids: Iterable<string>): void {
  visible = new Set(ids)
  for (const l of listeners) l()
}

export function isVisibleTask(id: string): boolean {
  return visible.has(id)
}

export function onVisibleTasks(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
