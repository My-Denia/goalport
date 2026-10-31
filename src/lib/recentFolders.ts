// Folders the user started goals in, newest first, so returning to a project is one press.
// A convenience only: Core still checks the folder, and missing storage just hides the list.
const KEY = "goalport.recentFolders";
const LIMIT = 5;

export function readRecentFolders(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecentFolder(folder: string): void {
  const clean = folder.trim();
  if (!clean) return;
  try {
    const same = (item: string) => item.toLowerCase() === clean.toLowerCase();
    localStorage.setItem(KEY, JSON.stringify([clean, ...readRecentFolders().filter((item) => !same(item))].slice(0, LIMIT)));
  } catch {
    // The list simply stays as it was.
  }
}

/** The last path segment: what people call their project. */
export function folderName(folder: string): string {
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}
