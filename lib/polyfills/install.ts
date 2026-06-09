/**
 * Hermes may omit browser globals that `@google/genai` or WebSocket helpers expect.
 * Install before any Gemini client import (see root `app/_layout.tsx`).
 */
if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMExceptionPolyfill extends Error {
    constructor(message = '', name = 'Error') {
      super(typeof message === 'string' ? message : String(message));
      this.name = name;
      Object.setPrototypeOf(this, DOMExceptionPolyfill.prototype);
    }
  } as unknown as typeof DOMException;
}

if (typeof globalThis.EventTarget === 'undefined') {
  class EventTargetPolyfill {
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return true;
    }
  }
  globalThis.EventTarget = EventTargetPolyfill as unknown as typeof EventTarget;
}
