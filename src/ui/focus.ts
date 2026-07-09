// Focus handling for modal overlays: remember what had keyboard focus when a modal
// opened, move focus into the modal, and put it back on close (if the old element still
// exists). Typed against a minimal Focusable surface so the behavior is testable headless.

export interface Focusable {
  focus(): void;
  isConnected?: boolean;
}

export class FocusScope {
  private prev: Focusable | null = null;

  open(target: Focusable | null, previous: Focusable | null): void {
    this.prev = previous;
    target?.focus();
  }

  close(): void {
    const prev = this.prev;
    this.prev = null;
    if (prev && prev.isConnected !== false) prev.focus();
  }
}

// The currently focused element, if it's something we can meaningfully return focus to.
export function currentFocus(): Focusable | null {
  const el = document.activeElement;
  return el instanceof HTMLElement ? el : null;
}
