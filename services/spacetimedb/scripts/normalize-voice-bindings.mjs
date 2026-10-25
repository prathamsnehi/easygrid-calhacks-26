import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI 2.13 emits extensionless local imports. Preserve its generated schema,
// adding the Node ESM suffix needed after TypeScript compilation and explicit
// public function return types for TS7 portable declaration emit.
const directory = fileURLToPath(new URL('../voice-bindings/', import.meta.url));
async function normalize(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { await normalize(path); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const original = await readFile(path, 'utf8');
    let normalized = original.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (match, prefix, specifier, suffix) => {
      if (extname(specifier)) return match;
      return `${prefix}${specifier}.js${suffix}`;
    });
    normalized = normalized.replace(
      /export const (reducers|procedures) = __convertToAccessorMap\(([^;]+)\);/g,
      (_, name, value) => `export const ${name}: ReturnType<typeof __convertToAccessorMap<typeof ${value}>> = __convertToAccessorMap(${value});`,
    );
    if (normalized !== original) await writeFile(path, normalized);
  }
}
await normalize(directory);
console.log('Normalized generated voice bindings for Node ESM.');
