/**
 * Global test setup.
 *
 * Keeps the suite hermetic: no real Firebase, no AudioContext, no
 * BroadcastChannel required. Individual tests can opt in with vi.mock().
 */

// jsdom does not implement matchMedia (used by the PWA install hook).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
