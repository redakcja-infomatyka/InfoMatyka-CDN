(function (root) {
  'use strict';
  if (root.InfoMatykaThreeWayMerge) return;

  const MISSING = Symbol('missing');
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasStableIds = values => values.every(value => isObject(value) &&
    (typeof value.id === 'string' || typeof value.eventId === 'string'));

  function stable(value) {
    if (value === MISSING) return '"__infomatyka_missing__"';
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (isObject(value)) return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }

  function equal(left, right) {
    return left === right || stable(left) === stable(right);
  }

  function copy(value) {
    if (value === MISSING) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function pathFor(path, key) {
    return path + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function recordConflict(state, path, base, local, remote, type, entityId) {
    state.conflicts.push({
      dataset: state.dataset,
      entityId: entityId || null,
      path: path || '/',
      base: base === MISSING ? null : copy(base),
      basePresent: base !== MISSING,
      local: local === MISSING ? null : copy(local),
      localPresent: local !== MISSING,
      remote: remote === MISSING ? null : copy(remote),
      remotePresent: remote !== MISSING,
      type: type || 'field'
    });
  }

  function setPath(root, path, value, present, now) {
    const parts = path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length) return present ? copy(value) : null;
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      if (Array.isArray(parent)) {
        let row = parent.find(item => String(item.id || item.eventId) === part);
        if (!row) { row = { id: part }; parent.push(row); }
        parent = row;
      } else {
        if (!isObject(parent[part]) && !Array.isArray(parent[part])) parent[part] = {};
        parent = parent[part];
      }
    }
    const leaf = parts[parts.length - 1];
    if (Array.isArray(parent)) {
      const position = parent.findIndex(item => String(item.id || item.eventId) === leaf);
      if (present) {
        if (position < 0) parent.push(copy(value));
        else parent[position] = copy(value);
      } else if (position >= 0) {
        const deleted = copy(parent[position]);
        deleted.deletedAt = Number(now());
        deleted.__deleted = true;
        parent[position] = deleted;
      }
      return root;
    }
    if (present) parent[leaf] = copy(value);
    else delete parent[leaf];
    return root;
  }

  function resolveConflicts(result, choices, options = {}) {
    const merged = copy(result.merged), now = options.now || Date.now;
    for (const conflict of result.conflicts) {
      const choice = choices[conflict.dataset + ':' + conflict.path];
      if (!['base', 'local', 'remote'].includes(choice)) throw new Error('Nie rozstrzygnięto konfliktu „' + conflict.path + '”.');
      const value = conflict[choice], present = conflict[choice + 'Present'];
      setPath(merged, conflict.path, value, present, now);
    }
    return { merged, conflicts: [], stats: { ...result.stats, conflicts: 0 } };
  }

  function deletionCopy(value, now) {
    const tombstone = value === MISSING ? {} : copy(value);
    tombstone.deletedAt = Number(now());
    tombstone.__deleted = true;
    return tombstone;
  }

  function collectionMap(values, path, state, side) {
    const result = new Map();
    for (const item of values) {
      const id = item.id || item.eventId;
      if (result.has(id)) {
        recordConflict(state, path, MISSING, side === 'local' ? values : MISSING,
          side === 'remote' ? values : MISSING, 'duplicate-id', id);
        return null;
      }
      result.set(String(id), item);
    }
    return result;
  }

  function entityOrder(base, local, remote, merged) {
    const ids = new Set(merged.keys());
    const baseIds = base.map(item => String(item.id || item.eventId));
    const stableIds = [...ids].filter(id => !baseIds.includes(id)).sort((left, right) => left.localeCompare(right));
    const orderById = new Map();
    for (const item of [...base, ...local, ...remote]) {
      const id = String(item.id || item.eventId);
      if (Number.isFinite(item.order)) orderById.set(id, item.order);
    }
    if (orderById.size) {
      return [...ids].sort((left, right) => {
        const leftOrder = orderById.has(left) ? orderById.get(left) : Number.MAX_SAFE_INTEGER;
        const rightOrder = orderById.has(right) ? orderById.get(right) : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right);
      });
    }
    const existing = baseIds.filter(id => ids.has(id));
    return [...existing, ...stableIds];
  }

  function mergeEntityCollection(base, local, remote, path, state) {
    const baseById = collectionMap(base, path, state, 'base');
    const localById = collectionMap(local, path, state, 'local');
    const remoteById = collectionMap(remote, path, state, 'remote');
    if (!baseById || !localById || !remoteById) return copy(local);

    const allIds = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
    const merged = new Map();
    for (const id of allIds) {
      const before = baseById.has(id) ? baseById.get(id) : MISSING;
      const left = localById.has(id) ? localById.get(id) : MISSING;
      const right = remoteById.has(id) ? remoteById.get(id) : MISSING;
      const entityPath = pathFor(path, id);

      if (before === MISSING && left !== MISSING && right !== MISSING && !equal(left, right)) {
        recordConflict(state, entityPath, before, left, right, 'id-collision', id);
        merged.set(id, copy(left));
        continue;
      }

      if (before === MISSING && (left !== MISSING || right !== MISSING)) {
        state.stats[left === MISSING ? 'addedRemote' : 'addedLocal']++;
      }

      if (before !== MISSING && (left === MISSING || right === MISSING)) {
        const survivor = left === MISSING ? right : left;
        if (survivor === MISSING) {
          merged.set(id, deletionCopy(before, state.now));
          state.stats.deleted++;
          continue;
        }
        if (survivor.__deleted === true || equal(survivor, before)) {
          merged.set(id, deletionCopy(survivor, state.now));
          state.stats.deleted++;
          continue;
        }
        recordConflict(state, entityPath, before, left, right, 'delete-edit', id);
        if (left !== MISSING) merged.set(id, copy(left));
        else merged.set(id, copy(right));
        continue;
      }

      if (left === MISSING && right === MISSING) continue;
      const result = mergeValue(before, left, right, entityPath, state, id);
      if (result !== MISSING) merged.set(id, result);
    }

    return entityOrder(base, local, remote, merged).map(id => merged.get(id));
  }

  function mergeSet(base, local, remote, path, state) {
    const identity = entry => String(isObject(entry) ? entry.id || entry.value || entry.url || '' : entry);
    const toEntities = entries => entries.map(entry => isObject(entry) ? { id: identity(entry), ...entry } : { id: identity(entry), value: entry });
    const merged = mergeEntityCollection(toEntities(base), toEntities(local), toEntities(remote), path, state);
    const explicitIds = new Set([...base, ...local, ...remote]
      .filter(isObject)
      .filter(entry => typeof entry.id === 'string' && entry.id)
      .map(identity));
    return merged.map(entry => {
      if (entry.__deleted === true || explicitIds.has(String(entry.id))) return entry;
      if (Object.keys(entry).every(key => key === 'id' || key === 'value')) return entry.value;
      const { id, ...value } = entry;
      return value;
    });
  }

  function mergeEvents(base, local, remote, path, state) {
    const byId = new Map();
    for (const event of [...base, ...local, ...remote]) {
      const id = event && (event.eventId || event.id);
      if (typeof id !== 'string' || !id) {
        recordConflict(state, path, base, local, remote, 'invalid-event-id');
        return copy(local);
      }
      if (byId.has(id) && !equal(byId.get(id), event)) {
        recordConflict(state, pathFor(path, id), MISSING, byId.get(id), event, 'event-id-collision', id);
        continue;
      }
      byId.set(id, event);
    }
    return [...byId.keys()].sort().map(id => copy(byId.get(id)));
  }

  function mergeValue(base, local, remote, path, state, entityId) {
    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
      if (state.strategy === 'event-union') return mergeEvents(base, local, remote, path, state);
      if (state.strategy === 'set-union') return mergeSet(base, local, remote, path, state);
      const all = [...base, ...local, ...remote];
      if (all.length && hasStableIds(all)) return mergeEntityCollection(base, local, remote, path, state);
    }

    if (local !== MISSING && remote !== MISSING && base !== MISSING &&
        isObject(base) && isObject(local) && isObject(remote)) {
      if (local.__deleted === true && !equal(remote, base)) {
        recordConflict(state, path, base, local, remote, 'delete-edit', entityId);
        return copy(local);
      }
      if (remote.__deleted === true && !equal(local, base)) {
        recordConflict(state, path, base, local, remote, 'delete-edit', entityId);
        return copy(local);
      }
      const result = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      for (const key of keys) {
        const before = own(base, key) ? base[key] : MISSING;
        const left = own(local, key) ? local[key] : MISSING;
        const right = own(remote, key) ? remote[key] : MISSING;
        const value = mergeValue(before, left, right, pathFor(path, key), state, entityId);
        if (value !== MISSING) result[key] = value;
      }
      return result;
    }

    if (equal(local, base)) return copy(remote);
    if (equal(remote, base)) return copy(local);
    if (equal(local, remote)) return copy(local);

    recordConflict(state, path, base, local, remote, 'field', entityId);
    state.stats.conflicts++;
    return copy(local);
  }

  function mergeThreeWay(base, local, remote, options = {}) {
    const state = {
      dataset: options.dataset || null,
      strategy: options.strategy || 'field-merge',
      now: options.now || Date.now,
      conflicts: [],
      stats: { addedLocal: 0, addedRemote: 0, updatedLocal: 0, updatedRemote: 0, deleted: 0, conflicts: 0 }
    };
    const merged = mergeValue(base === undefined ? MISSING : base, local === undefined ? MISSING : local,
      remote === undefined ? MISSING : remote, '', state, null);
    state.stats.conflicts = state.conflicts.length;
    return { merged: merged === MISSING ? null : merged, conflicts: state.conflicts, stats: state.stats };
  }

  const api = Object.freeze({ stable, mergeThreeWay, resolveConflicts });
  root.InfoMatykaThreeWayMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
