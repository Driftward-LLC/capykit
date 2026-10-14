export type Appearance = "light" | "dark" | "system";

export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem("capykit.appearance");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function saveAppearance(value: Appearance): void {
  // Appearance is the only persisted value; denied storage must not block sign-in.
  try { localStorage.setItem("capykit.appearance", value); } catch { /* Session-only preference. */ }
}
