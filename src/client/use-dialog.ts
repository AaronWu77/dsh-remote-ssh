import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

/**
 * Focus a modal dialog on open, close it on Escape, and keep Tab inside it
 * while it is open. The returned ref belongs on the dialog container, which
 * must carry `tabIndex={-1}` so it can hold focus before the first control.
 * @param open - whether the dialog is rendered.
 * @param onCancel - invoked for Escape and for an empty focus cycle.
 * @returns The dialog container ref.
 */
export function useDialogFocus(open: boolean, onCancel: () => void): RefObject<HTMLDivElement> {
  const container = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  const previousFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    const root = container.current
    if (root === null) return
    const active = document.activeElement
    previousFocus.current = active instanceof HTMLElement && active !== document.body ? active : null
    root.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('[role="dialog"]') !== root) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel.current()
        return
      }
      if (event.key !== 'Tab') return
      event.stopPropagation()
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element =>
        !element.hasAttribute('disabled') && element.closest('[role="dialog"]') === root,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        root.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      const activeElement = document.activeElement
      const inside = activeElement === root || root.contains(activeElement)
      if (event.shiftKey && (!inside || activeElement === first || activeElement === root)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (!inside || activeElement === last || activeElement === root)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      const restore = previousFocus.current
      previousFocus.current = null
      if (restore?.isConnected) restore.focus({ preventScroll: true })
    }
  }, [open])
  return container
}
