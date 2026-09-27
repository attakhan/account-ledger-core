/**
 * Filesystem anchors. Code runs compiled from dist/ (dist/src/paths.js), so
 * the compiled tree is one level up from here and the repository (data/,
 * bench-out/) is one level above that.
 */
import * as path from 'node:path';

export const DIST_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(DIST_ROOT, '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
