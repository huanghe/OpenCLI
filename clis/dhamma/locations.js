// dhamma locations — look up the region / state / centre names (and ids)
// that `dhamma search` accepts.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { LOCATION_KINDS, cleanText, fetchSearchMeta, findLocations, requireLimit } from './utils.js';

export function listLocations(meta, args) {
  const query = cleanText(args.query);
  if (!query) throw new ArgumentError('dhamma locations query must not be empty');
  const kind = cleanText(args.kind).toLowerCase();
  if (kind && !LOCATION_KINDS.includes(kind)) {
    throw new ArgumentError(`dhamma --kind must be one of: ${LOCATION_KINDS.join(', ')}`);
  }
  const limit = requireLimit(args.limit, { max: 200 });
  return findLocations(meta.locations, query, { kind: kind || undefined })
    .slice(0, limit)
    .map((loc) => ({ kind: loc.kind, id: loc.key, name: loc.name }));
}

cli({
  site: 'dhamma',
  name: 'locations',
  access: 'read',
  description: 'Find dhamma.org regions, states and centres usable as `dhamma search` locations',
  domain: 'www.dhamma.org',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', positional: true, type: 'string', required: true, help: 'Name keyword, e.g. taiwan, medini, california' },
    { name: 'kind', type: 'string', default: '', help: 'Only one kind: region | state | location | sublocation' },
    { name: 'limit', type: 'int', default: 20, help: 'Max rows (1-200)' },
  ],
  columns: ['kind', 'id', 'name'],
  func: async (args) => {
    const rows = listLocations(await fetchSearchMeta(), args);
    if (rows.length === 0) {
      throw new EmptyResultError('dhamma locations', `No region, state or centre matches "${cleanText(args.query)}".`);
    }
    return rows;
  },
});
