import type { BaseRenderable } from "@opentui/core"

/**
 * Minimal structural shape shared by every OpenTUI container we manipulate.
 * Declared structurally so callers can pass `BoxRenderable`, `ScrollBoxRenderable`
 * etc. without narrowing to a concrete class.
 */
export interface RenderableParent {
  getRenderable(id: string): BaseRenderable | undefined
  remove(child: BaseRenderable): void
}

/**
 * OpenTUI 0.6 removed `Renderable.remove(id: string)` in favour of
 * `remove(child: BaseRenderable)`. This resolves a child by id first and
 * removes it when present, keeping the call sites readable.
 */
export function removeChildById(parent: RenderableParent, id: string): void {
  const child = parent.getRenderable(id)
  if (child) parent.remove(child)
}
