import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Inline Markdown links and images outside fenced code. External URLs and
// same-page anchors are not checked; a "#anchor" suffix is dropped.
export function markdownLinks(text) {
  const links = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(```|~~~)/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const [, target] of prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = decodeURI(target.split("#")[0]);
      if (path) links.push(path);
    }
  }
  return links;
}

// GitHub resolves paths case-sensitively; Windows does not. Compare each
// segment with the real directory entry so a case mismatch is reported.
function existsExactCase(root, target) {
  const parts = relative(root, target).split(sep).filter(Boolean);
  // A link that leaves the repository cannot resolve on GitHub.
  if (parts[0] === ".." || isAbsolute(relative(root, target))) return false;
  let current = root;
  for (const part of parts) {
    if (!existsSync(current) || !statSync(current).isDirectory()) return false;
    if (!readdirSync(current).includes(part)) return false;
    current = resolve(current, part);
  }
  return true;
}

export function brokenLinks(root, files, { allow = {} } = {}) {
  const broken = [];
  for (const file of files) {
    const source = resolve(root, file);
    for (const link of markdownLinks(readFileSync(source, "utf8"))) {
      if ((allow[file] ?? []).includes(link)) continue;
      const target = link.startsWith("/") ? resolve(root, `.${link}`) : resolve(dirname(source), link);
      if (!existsExactCase(root, target)) broken.push({ file, link });
    }
  }
  return broken;
}

export function markdownFiles(root, directory) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}
