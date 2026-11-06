/** Per-device preferences. Storage may be unavailable (private mode, iframes), so never rely on it. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`twinmind:${key}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`twinmind:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
