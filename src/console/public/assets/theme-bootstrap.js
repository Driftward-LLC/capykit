// Runs synchronously before styles/modules, without relaxing the hosted script-src 'self' policy.
try {
  const mode = globalThis.localStorage.getItem('capykit.appearance');
  if (mode === 'light' || mode === 'dark') globalThis.document.documentElement.dataset.theme = mode;
} catch { /* Follow system preference when storage is unavailable. */ }
