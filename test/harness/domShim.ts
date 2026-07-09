// Minimal headless DOM/global shim so the browser-coupled `Game` class can be
// constructed and its `update(dt)` driven in Node for golden-master capture. It is NOT a
// real DOM — it just makes constructors/side-effects no-op cleanly. Rendering is never
// run in the oracle; only the pure simulation half of `update` is exercised.
//
// Import this module FIRST (before any src/game module) so the globals exist before the
// game's module graph loads (audio.ts wires window listeners at construction).

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = (): void => {};

// Window event listeners are REAL (registered + removable + dispatchable) so UI suites can
// exercise keyboard contracts (Escape-to-back, game-over retry keys). Dispatch only happens
// when a test calls fireWindowEvent — game/golden suites just accumulate inert handlers.
const windowListeners = new Map<string, Set<(ev: unknown) => void>>();

export function fireWindowEvent(type: string, ev: Record<string, unknown> = {}): void {
  const event = { key: "", preventDefault: noop, stopPropagation: noop, ...ev };
  for (const fn of [...(windowListeners.get(type) ?? [])]) fn(event);
}

// The last element that received .focus(), so tests can assert focus restore by NAME.
let lastFocusedStore: unknown = null;

export function lastFocused(): { tagName?: string; className?: string; textContent?: string } | null {
  return lastFocusedStore as { tagName?: string; className?: string; textContent?: string } | null;
}

const ctxStub: any = new Proxy(
  {},
  {
    get(_t, p) {
      if (p === "canvas") return null;
      if (p === "createLinearGradient" || p === "createRadialGradient" || p === "createPattern") {
        return () => ({ addColorStop: noop });
      }
      if (p === "measureText") return () => ({ width: 0 });
      if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (p === "createImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      return noop;
    },
    set() {
      return true;
    },
  }
);

const rectStub = () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0 });

function makeStyle(): any {
  return new Proxy(
    {},
    {
      get: (_t, p) => (p === "setProperty" || p === "removeProperty" ? noop : ""),
      set: () => true,
    }
  );
}

function makeClassList(): any {
  return { add: noop, remove: noop, toggle: noop, replace: noop, contains: () => false };
}

let documentStub: any;

function makeEl(tag = "div"): any {
  const store: any = { tagName: (tag || "div").toUpperCase(), nodeType: 1, tag };
  const style = makeStyle();
  const classList = makeClassList();
  // Real child/text tracking so UI tests (menu) can assert on the rendered tree; the game
  // oracle never reads these, so golden capture behavior is unchanged.
  const children: any[] = [];
  let width = 1280;
  let height = 720;
  return new Proxy(store, {
    get(t, p: any) {
      switch (p) {
        case "style":
          return style;
        case "classList":
          return classList;
        case "dataset":
          return t.__dataset ?? (t.__dataset = {});
        case "getContext":
          return () => ctxStub;
        case "appendChild":
        case "insertBefore":
          return (c: any) => { children.push(c); return c; };
        case "append":
          return (...cs: any[]) => { children.push(...cs); };
        case "prepend":
          return (...cs: any[]) => { children.unshift(...cs); };
        case "removeChild":
          return (c: any) => c;
        case "replaceChildren":
          return (...cs: any[]) => { children.length = 0; children.push(...cs); };
        case "remove":
        case "setAttributeNS":
        case "addEventListener":
        case "removeEventListener":
        case "blur":
        case "click":
        case "scrollIntoView":
        case "setPointerCapture":
        case "releasePointerCapture":
        case "after":
        case "before":
          return noop;
        // Attributes are tracked (not styled) so UI suites can assert accessibility
        // contracts (aria-label/aria-pressed) exactly as written by the real code.
        case "setAttribute":
          return (k: string, v: string) => { (t.__attrs ?? (t.__attrs = {}))[k] = String(v); };
        case "getAttribute":
          return (k: string) => (t.__attrs && k in t.__attrs ? t.__attrs[k] : null);
        case "removeAttribute":
          return (k: string) => { if (t.__attrs) delete t.__attrs[k]; };
        case "focus":
          return () => { lastFocusedStore = t; };
        case "getBoundingClientRect":
          return rectStub;
        case "width":
          return width;
        case "height":
          return height;
        case "clientWidth":
        case "offsetWidth":
          return 1280;
        case "clientHeight":
        case "offsetHeight":
          return 720;
        case "querySelector":
        case "closest":
          return () => makeEl();
        case "querySelectorAll":
        case "getElementsByClassName":
        case "getElementsByTagName":
          return () => [];
        case "children":
        case "childNodes":
          return children;
        case "parentNode":
        case "parentElement":
        case "firstChild":
        case "lastChild":
        case "nextSibling":
          return null;
        case "ownerDocument":
          return documentStub;
        case "cloneNode":
          return () => makeEl(tag);
        default:
          if (p in t) return t[p];
          return undefined;
      }
    },
    set(t, p: any, v) {
      if (p === "width") {
        width = v;
        return true;
      }
      if (p === "height") {
        height = v;
        return true;
      }
      t[p] = v;
      return true;
    },
  });
}

documentStub = {
  createElement: (tag: string) => makeEl(tag),
  createElementNS: () => makeEl(),
  createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
  createDocumentFragment: () => makeEl(),
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  body: makeEl("body"),
  head: makeEl("head"),
  documentElement: makeEl("html"),
  fonts: { load: () => Promise.resolve(), ready: Promise.resolve(), forEach: noop },
  hidden: false,
  visibilityState: "visible",
};

const localStorageStub: any = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
})();

class ImageStub {
  src = "";
  width = 0;
  height = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
}

class AudioContextStub {
  state = "suspended";
  currentTime = 0;
  destination = {};
  createGain() {
    return { gain: { value: 1, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, connect: () => ({ connect: noop }) };
  }
  createOscillator() {
    return { type: "sine", frequency: { value: 0, setValueAtTime: noop }, connect: () => ({ connect: noop }), start: noop, stop: noop };
  }
  createBufferSource() {
    return { buffer: null, playbackRate: { value: 1 }, connect: () => ({ connect: noop }), start: noop, stop: noop };
  }
  decodeAudioData() {
    return Promise.resolve({});
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

const windowStub: any = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  addEventListener: (type: string, fn: (ev: unknown) => void) => {
    let set = windowListeners.get(type);
    if (!set) { set = new Set(); windowListeners.set(type, set); }
    set.add(fn);
  },
  removeEventListener: (type: string, fn: (ev: unknown) => void) => {
    windowListeners.get(type)?.delete(fn);
  },
  location: { search: "", href: "http://localhost/", hash: "", pathname: "/" },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: () => 0,
  clearInterval: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  getComputedStyle: () => makeStyle(),
  navigator: { userAgent: "node", language: "en-US" },
  localStorage: localStorageStub,
  document: documentStub,
  fetch: () => Promise.reject(new Error("no fetch in oracle harness")),
};

const g = globalThis as any;
function put(key: string, value: unknown): void {
  try {
    g[key] = value;
  } catch {
    // Some globals (navigator) are getter-only on globalThis in Node; force-define.
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
}
put("window", windowStub);
put("document", documentStub);
put("navigator", windowStub.navigator);
put("localStorage", localStorageStub);
put("location", windowStub.location);
put("requestAnimationFrame", windowStub.requestAnimationFrame);
put("cancelAnimationFrame", windowStub.cancelAnimationFrame);
put("matchMedia", windowStub.matchMedia);
put("getComputedStyle", windowStub.getComputedStyle);
put("Image", ImageStub);
put("AudioContext", AudioContextStub);
put("webkitAudioContext", AudioContextStub);
put("HTMLElement", class {});
put("HTMLCanvasElement", class {});
put("HTMLImageElement", ImageStub);
if (!g.performance) put("performance", { now: () => 0 });

export const domCanvas = makeEl("canvas");
export const domMinimap = makeEl("canvas");
export const domOverlay = makeEl("div");
