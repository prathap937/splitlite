export const STORAGE_KEY = 'splitwiselite:v1';

export function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultState() {
  return {
    groups: [],
    activeGroupId: null,
    rates: { values: null, updatedAt: null },
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (err) {
    console.error('Failed to load saved data, starting fresh.', err);
    return defaultState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
