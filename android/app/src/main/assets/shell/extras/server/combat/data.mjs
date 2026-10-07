// server/combat/data.mjs — one immutable full dataset and one normalization cache per thread, shared by all
// phase engines (shell overlay; see server/overlay/sp-combat-pool.mjs).
import { deepFreeze, getData } from '../data.js';
import { DataSource } from '../sim/simdata.js';

let installed = null;
let source = null;
export function combatData(data = installed ?? getData()) {
  if (!data || typeof data !== 'object' || data instanceof DataSource || typeof data.getChess === 'function') {
    throw new TypeError('combat data must be the full raw dataset, not a DataSource');
  }
  if (installed && data !== installed) throw new Error('combat data cannot change within a thread');
  if (!installed) {
    // Freeze the transferred copy; upstream content modules read the same records through their own
    // getData() singleton (same data/ directory), so no second dataset can be resolved here.
    installed = deepFreeze(data);
    source = new DataSource(installed);
  }
  return source;
}
