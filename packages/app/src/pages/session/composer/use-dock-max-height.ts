import { onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

/**
 * Mounts a measurement loop that maintains a CSS custom property on
 * `getRoot()` so the dock can never extend past the visible viewport.
 *
 * The shipped UI's catch-all docks default to `100dvh`, which on iOS
 * Safari does not shrink when the soft keyboard is up or the URL bar
 * is visible. Without this clamp, the footer (Submit / Allow / Deny)
 * can be clipped behind the keyboard or below the screen and become
 * unreachable. Measurement runs on every relevant viewport change:
 * window resize, visualViewport resize/scroll (mobile keyboard, URL
 * bar collapse), and the parent dock + scroll-view resizing.
 *
 * The result is always non-negative; clipping is never preferred over
 * a tight dock, since the option list scrolls internally.
 */
export function useDockMaxHeight(input: { property: string; getRoot: () => HTMLElement | undefined }) {
  const visibleBottom = () => {
    const vv = window.visualViewport
    if (vv) return vv.offsetTop + vv.height
    return window.innerHeight
  }

  const measure = () => {
    const root = input.getRoot()
    if (!root) return

    // The session timeline pins a sticky header (`data-session-title`)
    // to the top of the scroll viewport. When present, use its bottom
    // edge as the upper bound of available space so the dock never
    // overlaps the title bar.
    const head = document.querySelector("[data-session-title]")
    const top = head instanceof HTMLElement ? head.getBoundingClientRect().bottom : 0
    const visible = visibleBottom()
    const gap = 8

    let available: number

    if (!top) {
      // No sticky session-title in the DOM (first paint, route
      // transitions, or pages without a timeline). Use the dock's own
      // top edge as the upper bound so we don't assume the page
      // chrome is zero (which would push max-height past the visible
      // region).
      const rootTop = Math.max(0, root.getBoundingClientRect().top)
      available = visible - rootTop - gap
    } else {
      const dock = root.closest('[data-component="session-prompt-dock"]')
      if (!(dock instanceof HTMLElement)) return

      // Clamp dockBottom against the visible viewport so a soft
      // keyboard pushing the dock below the screen doesn't yield a
      // max-height that extends past what the user can actually see.
      const dockBottom = Math.min(dock.getBoundingClientRect().bottom, visible)
      const below = Math.max(0, dock.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom)
      available = dockBottom - top - gap - below
    }

    root.style.setProperty(input.property, `${Math.floor(Math.max(0, available))}px`)
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    // Run synchronously on first paint so the dock never flashes at
    // the CSS-fallback `100dvh` before the first measurement lands —
    // important on iOS when the soft keyboard is already up at mount.
    measure()

    makeEventListener(window, "resize", update)
    // Track visualViewport on mobile so soft-keyboard appearance and
    // URL-bar collapse re-run the measurement. Undefined in some
    // embedded webviews; the listener helper is a no-op there.
    if (window.visualViewport) {
      makeEventListener(window.visualViewport, "resize", update)
      makeEventListener(window.visualViewport, "scroll", update)
    }

    // The observer target list is captured at mount time. If the
    // scroll-view mounts later (e.g. transition between sessions
    // before the message timeline is ready), we miss its resize
    // events — but the window/visualViewport listeners still catch
    // the keyboard and URL-bar cases that actually matter for the
    // mobile-clipping bug this helper exists to solve.
    const root = input.getRoot()
    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })
  })
}
