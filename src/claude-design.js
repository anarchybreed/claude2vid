// Claude Design-specific helpers:
//   - detectMeta(): regex-scrape Stage width/height/duration from JSX files in
//     the input directory. Best-effort — returns whatever it finds.
//   - chromeHideCSS: CSS injected when --hide-chrome is passed, to suppress
//     the Stage's playback bar and reset its auto-scale.

import fs from 'node:fs/promises';
import path from 'node:path';

const NUM = String.raw`(\d+(?:\.\d+)?)`;

// Property inside a JSX-style Stage tag: matches both `width={1080}` (literal)
// and `duration={DURATION}` (identifier — we resolve the const separately).
const PROP_LITERAL = (prop) => new RegExp(`\\b${prop}\\s*=\\s*\\{\\s*${NUM}\\s*\\}`);
const PROP_IDENT   = (prop) => new RegExp(`\\b${prop}\\s*=\\s*\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\}`);

// Strip JS line/block comments before searching, so we don't match Stage props
// that appear in usage-example comments (animations.jsx has one).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Pull a `<Stage ...>` open tag (may span lines) out of a source string.
function findStageOpenTag(src) {
  // Non-greedy match from `<Stage` to the next `>` that closes the open tag.
  // Allow `/>` self-closing too.
  const m = src.match(/<Stage\b[\s\S]*?\/?>/);
  return m ? m[0] : null;
}

// Resolve `const FOO = 45` style constants.
function findConst(src, name) {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*${NUM}\\b`));
  return m ? Number(m[1]) : null;
}

// Directories that won't contain Claude Design source — skipped by the walker.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);
const MAX_WALK_DEPTH = 3;

async function walkJsxLike(rootDir) {
  const found = [];
  async function visit(absDir, relDir, depth) {
    let entries;
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (depth >= MAX_WALK_DEPTH) continue;
        if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
        await visit(path.join(absDir, ent.name), path.posix.join(relDir, ent.name), depth + 1);
      } else if (ent.isFile() && /\.(jsx?|mjs)$/i.test(ent.name)) {
        found.push(path.posix.join(relDir, ent.name));
      }
    }
  }
  await visit(rootDir, '', 0);
  return found;
}

// Scan htmlPath and JSX/JS files within its directory (recursive, bounded) for
// `<Stage width={…} height={…} duration={…}>`-style props.
// Returns { width?, height?, duration? } — missing keys mean we couldn't find it.
export async function detectMeta(htmlPath) {
  const dir = path.dirname(htmlPath);
  const jsxRelPaths = await walkJsxLike(dir);
  const candidates = [path.basename(htmlPath), ...jsxRelPaths];

  // Read all sources up-front so we can resolve cross-file identifiers. Keys
  // are relative paths (e.g. "scenes/App.jsx") to avoid basename collisions.
  const sources = {};
  for (const relPath of candidates) {
    try { sources[relPath] = stripComments(await fs.readFile(path.join(dir, relPath), 'utf8')); }
    catch { /* ignore */ }
  }

  const result = {};

  // Pass 1: JSX `<Stage width={N} height={N} duration={N}>` pattern.
  for (const [name, src] of Object.entries(sources)) {
    const tag = findStageOpenTag(src);
    if (!tag) continue;
    for (const prop of ['width', 'height', 'duration']) {
      if (result[prop] != null) continue;
      const lit = tag.match(PROP_LITERAL(prop));
      if (lit) { result[prop] = Number(lit[1]); continue; }
      const ident = tag.match(PROP_IDENT(prop));
      if (ident) {
        const here = findConst(src, ident[1]);
        if (here != null) { result[prop] = here; continue; }
        for (const other of Object.values(sources)) {
          const there = findConst(other, ident[1]);
          if (there != null) { result[prop] = there; break; }
        }
      }
    }
    if (result.width != null && result.height != null && result.duration != null) break;
  }

  // Pass 2: CSS `#stage { width: Npx; height: Npx }` pattern (sort-bubble style).
  if (result.width == null || result.height == null) {
    for (const src of Object.values(sources)) {
      const block = src.match(/#stage\s*\{[^}]+\}/);
      if (!block) continue;
      if (result.width == null) {
        const m = block[0].match(/\bwidth\s*:\s*(\d+(?:\.\d+)?)\s*px\b/);
        if (m) result.width = Number(m[1]);
      }
      if (result.height == null) {
        const m = block[0].match(/\bheight\s*:\s*(\d+(?:\.\d+)?)\s*px\b/);
        if (m) result.height = Number(m[1]);
      }
      if (result.width != null && result.height != null) break;
    }
  }

  return result;
}

// CSS injected when --hide-chrome is set. Targets the Stage component from
// animations.jsx via its structural layout (which is stable across Claude
// Design output) plus style-attribute fingerprints as a fallback. Opt-in
// because many users want the playback bar visible.
//
// The Stage's outer container looks like:
//   <div id="root">
//     <div>                        ← Stage outer (position: absolute, inset: 0)
//       <div>                      ← canvas wrapper (flex: 1)
//         <div ref={canvasRef}>... ← the actual canvas (transform: scale(s))
//       </div>
//       <PlaybackBar />            ← the chrome we hide
//     </div>
//   </div>
export const chromeHideCSS = `
/* Hide Stage playback bar (structural: second direct child of Stage outer) */
#root > div > div:nth-child(2),
#root > div > *:last-child:not(:first-child) { display: none !important; }

/* Reset the Stage's auto-scale transform so the canvas renders at native
   pixels. Scoped to the canvas wrapper specifically (Stage outer's first child)
   so we don't disturb scene-level transforms (e.g. the Anchor zoom in the
   "Cosmic Scale Zoom Reverse" example, which uses inline transform: scale() on
   scene divs and would otherwise be flattened). */
#root > div > div:first-child > div { transform: none !important; }
#root > div > div:first-child { align-items: stretch !important; justify-content: stretch !important; }

/* Full-bleed root */
html, body, #root { width: 100% !important; height: 100% !important; margin: 0 !important; padding: 0 !important; background: #000 !important; }
#root > div { background: transparent !important; }
`;
