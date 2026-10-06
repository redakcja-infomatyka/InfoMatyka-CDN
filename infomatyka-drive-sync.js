/* InfoMatyka: private, browser-only Google Drive synchronization (schema 3).
 * OAuth access survives navigation in tab-scoped sessionStorage until Google expiry.
 * Each device writes its own head; no client secrets or refresh tokens are used.
 * Vector clocks detect simultaneous changes; the user chooses one global action.
 */
(function (root) {
  'use strict';
  if (root.InfoMatykaDrive) return;
  const DATA_REGISTRY = root.InfoMatykaDataRegistry || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-data-registry.js') : null);
  const MERGE_CORE = root.InfoMatykaThreeWayMerge || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-three-way-merge.js') : null);
  if (!DATA_REGISTRY || !MERGE_CORE) throw new Error('Nie załadowano centralnego rejestru ani modułu three-way merge.');
  const MODULE_VERSION = '4.0.0';
  const SYNC_SCHEMA = 3;
  const BOARD_SCHEMA = 4;
  const BOARD_DB_VERSION = 4;
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const SETTINGS_KEY = 'infomatyka-sync-preferences';
  const DEVICE_KEY = 'infomatyka-sync-device';
  const STATE_PREFIX = 'infomatyka-sync-state-';
  const BASE_STORE_NAME = 'infomatyka-sync-bases';
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_ASSET_BYTES = 80 * 1024 * 1024;
  const MAX_ASSET_TOTAL_BYTES = 500 * 1024 * 1024;
  const RECOVERY_MAGIC = 'INFOMATYKA-DRIVE-RECOVERY\n';
  const RECOVERY_HEADER_LIMIT = 32 * 1024 * 1024;
  const MAX_FILES = 100;
  const BOARD_STORES = ['boards', 'boardIndex', 'folders', 'assets', 'meta'];
  const SYNCABLE_META_IDS = new Set();
  const CATEGORIES = DATA_REGISTRY.categories;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isDeletedRow = row => object(row) && row.__deleted === true;
  function projectBoardTombstones(data) {
    if (!object(data)) return data;
    return Object.fromEntries(Object.entries(data).map(([store, rows]) => [store,
      Array.isArray(rows) ? rows.filter(row => !isDeletedRow(row)) : rows]));
  }
  const withoutBlob = asset => { const { blob, ...record } = asset; return record; };
  function withoutDerivedProgress(value) {
    if (!object(value)) return value;
    const result = { ...value };
    delete result.xp;
    delete result.xpBaseline;
    if (object(result.stats)) {
      result.stats = { ...result.stats };
      delete result.stats.totalXp;
    }
    return result;
  }
  function progressBaseline(state, events) {
    if (!object(state)) return 0;
    const storedBaseline = Number(state.xpBaseline);
    if (state.xpBaseline !== undefined && state.xpBaseline !== null && state.xpBaseline !== '' && Number.isFinite(storedBaseline)) return storedBaseline;
    const totalXp = Number(state.xp ?? (state.stats && state.stats.totalXp)) || 0;
    const eventXp = Array.isArray(events) ? events.reduce((total, event) => total + (Number(event.deltaXp) || 0), 0) : 0;
    return totalXp - eventXp;
  }
  function restoreTombstones(current, base) {
    if (Array.isArray(current) && Array.isArray(base)) {
      const identity = item => object(item) ? String(item.id || item.eventId || '') : String(item);
      const currentById = new Map(current.map(item => [identity(item), item]));
      const baseById = new Map(base.map(item => [identity(item), item]));
      const result = [], included = new Set();
      for (const item of base) {
        const id = identity(item), currentItem = currentById.get(id);
        if (currentItem !== undefined) result.push(restoreTombstones(currentItem, item));
        else if (object(item) && item.__deleted === true) result.push(item);
        else continue;
        included.add(id);
      }
      for (const item of current) {
        const id = identity(item);
        if (!included.has(id)) result.push(baseById.has(id) ? restoreTombstones(item, baseById.get(id)) : item);
      }
      return result;
    }
    if (object(current) && object(base)) {
      const result = { ...current };
      for (const key of Object.keys(result)) if (has(base, key)) result[key] = restoreTombstones(result[key], base[key]);
      return result;
    }
    return current;
  }
  function stripTombstones(value) {
    if (Array.isArray(value)) return value.filter(item => !(object(item) && item.__deleted === true)).map(stripTombstones);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripTombstones(item)]));
    return value;
  }
  const manifestData = data => {
    if (!data || !has(data, 'boardAssetBlobs')) return data;
    const { boardAssetBlobs, ...manifest } = data;
    return manifest;
  };
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function decodeStoredValue(storage, key) {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
  function encodeStoredValue(value) { return JSON.stringify(value); }
  function dataBaseKey(account, datasetId) { return account + ':' + datasetId; }
  const byteSize = value => new TextEncoder().encode(stable(manifestData(value))).length;
  function validateBoards(data) {
    if (!object(data) || Object.keys(data).length !== BOARD_STORES.length || BOARD_STORES.some(name =>
      !Array.isArray(data[name]) || data[name].some(row => !object(row) || typeof row.id !== 'string' || !row.id) ||
      new Set(data[name].map(row => row.id)).size !== data[name].length)) throw new Error('Nieprawidłowa kopia biblioteki tablic.');
    const active = Object.fromEntries(BOARD_STORES.map(name => [name, data[name].filter(row => !isDeletedRow(row))]));
    const index = new Map(active.boardIndex.map(row => [row.id, row]));
    if (active.boards.some(row => !object(row.project) || !Array.isArray(row.project.pages) ||
      row.project.version !== '4.0' || !index.has(row.id) || index.get(row.id).deletedAt) ||
      active.boardIndex.some(row => typeof row.name !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        (!row.deletedAt && !active.boards.some(board => board.id === row.id))) ||
      active.folders.some(row => typeof row.name !== 'string') ||
      active.assets.some(row => typeof row.name !== 'string' || typeof row.mime !== 'string' ||
        !/^(image\/|application\/pdf$)/i.test(row.mime) || !Number.isSafeInteger(row.size) || row.size < 0 ||
        row.size > MAX_ASSET_BYTES || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !object(row.metadata))) {
      throw new Error('Kopia tablic jest niekompletna lub uszkodzona.');
    }
    if (active.assets.reduce((sum, asset) => sum + asset.size, 0) > MAX_ASSET_TOTAL_BYTES) {
      throw new Error('Biblioteka tablic przekracza łączny limit synchronizacji 500 MiB.');
    }
    const assets = new Set(active.assets.map(asset => asset.id));
    for (const board of active.boards) {
      const references = new Set();
      for (const page of board.project.pages) {
        if (page.background && page.background.assetId) references.add(page.background.assetId);
        const visit = value => {
          if (!value || typeof value !== 'object') return;
          if (typeof value.assetId === 'string') references.add(value.assetId);
          for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
        };
        visit(page.data);
      }
      if ([...references].some(id => !assets.has(id))) throw new Error('W bibliotece brakuje wymaganego obrazu lub dokumentu.');
    }
  }
  async function blobHash(blob, cryptoAPI) {
    if (!(blob instanceof Blob)) throw new Error('Zasób tablicy nie zawiera prawidłowego pliku.');
    if (blob.size > MAX_ASSET_BYTES) throw new Error('Pojedynczy zasób przekracza limit 80 MiB.');
    const bytes = await blob.arrayBuffer();
    return Array.from(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function validateAssetBlob(asset, blob, cryptoAPI) {
    if (!(blob instanceof Blob) || blob.size !== asset.size || blob.type !== asset.mime || await blobHash(blob, cryptoAPI) !== asset.sha256) return false;
    if (asset.mime === 'application/pdf') return (await blob.slice(0, 1024).text()).includes('%PDF-');
    if (!asset.mime.startsWith('image/')) return false;
    if (asset.mime === 'image/svg+xml') {
      const [start, end] = await Promise.all([blob.slice(0, 4096).text(), blob.slice(Math.max(0, blob.size - 4096)).text()]);
      return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(start) && /<\/svg\s*>\s*$/i.test(end);
    }
    if (typeof root.createImageBitmap === 'function') {
      let bitmap;
      try { bitmap = await root.createImageBitmap(blob); return bitmap.width > 0 && bitmap.height > 0; }
      catch (_) { return false; }
      finally { if (bitmap) bitmap.close(); }
    }
    const [start, end] = await Promise.all([blob.slice(0, 32).arrayBuffer(), blob.slice(Math.max(0, blob.size - 4)).arrayBuffer()]);
    const bytes = new Uint8Array(start), tail = new Uint8Array(end), ascii = (data, from, to) => String.fromCharCode(...data.slice(from, to));
    if (asset.mime === 'image/png') return bytes.length >= 24 && bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' &&
      ascii(bytes, 12, 16) === 'IHDR' && new DataView(bytes.buffer).getUint32(16) > 0 && new DataView(bytes.buffer).getUint32(20) > 0;
    if (asset.mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && tail[tail.length - 2] === 255 && tail[tail.length - 1] === 217;
    if (asset.mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) && tail[tail.length - 1] === 59;
    if (asset.mime === 'image/webp') return bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP' &&
      new DataView(bytes.buffer).getUint32(4, true) + 8 === blob.size;
    if (asset.mime === 'image/avif') return ascii(bytes, 4, 12).includes('ftypavif');
    return false;
  }
  class BoardStore {
    constructor(indexedDB, cryptoAPI, onChanged) { this.indexedDB = indexedDB; this.crypto = cryptoAPI; this.onChanged = onChanged; }
    async open(createIfMissing = true) {
      if (!this.indexedDB) throw new Error('Przeglądarka nie udostępnia bazy tablic (IndexedDB).');
      if (!createIfMissing && typeof this.indexedDB.databases === 'function') {
        const databases = await this.indexedDB.databases();
        if (!databases.some(database => database.name === 'infomatyka_tablice_interaktywne')) return null;
      }
      return new Promise((resolve, reject) => {
        const name = 'infomatyka_tablice_interaktywne';
        // Existing databases also need schema upgrades during read-only capture.
        // Opening without a version would leave older databases missing stores such as `assets`.
        const request = this.indexedDB.open(name, BOARD_DB_VERSION);
        let blocked = false, missing = false;
        request.onupgradeneeded = event => {
          if (!createIfMissing && event.oldVersion === 0) { missing = true; request.transaction.abort(); return; }
          BOARD_STORES.forEach(storeName => {
            if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
          });
        };
        request.onerror = () => missing ? resolve(null) : reject(request.error);
        request.onblocked = () => { blocked = true; reject(new Error('Zamknij inne karty tablic i spróbuj ponownie.')); };
        request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
      });
    }
    async transaction(mode, incoming, expected) {
      if (incoming) validateBoards(incoming);
      const db = await this.open(!!incoming);
      if (!db && mode === 'readonly') return Object.fromEntries(BOARD_STORES.map(name => [name, []]));
      if (!db) throw new Error('Nie udało się otworzyć bazy tablic.');
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORES, mode), snapshot = {}; let remaining = BOARD_STORES.length, reason, deviceMeta = [];
        tx.oncomplete = () => { db.close(); if (incoming && this.onChanged) this.onChanged(); resolve(snapshot); };
        tx.onerror = tx.onabort = () => { db.close(); reject(reason || tx.error || new Error('Nie udało się zapisać biblioteki tablic.')); };
        BOARD_STORES.forEach(name => {
          const store = tx.objectStore(name);
          store.getAll().onsuccess = event => {
            const records = event.target.result;
            if (name === 'meta') {
              deviceMeta = records.filter(row => !SYNCABLE_META_IDS.has(row.id));
              snapshot[name] = records.filter(row => SYNCABLE_META_IDS.has(row.id));
            } else snapshot[name] = records.map(row => name === 'assets' && incoming ? withoutBlob(row) : row).sort((a, b) => a.id.localeCompare(b.id));
            if (--remaining || !incoming) return;
            // Compare and replace in one IDB transaction, also against writes from the board page.
            if (stable(snapshot) !== stable(expected)) {
              reason = new Error('Tablice zmieniły się w innej karcie. Porównaj wersje ponownie.'); tx.abort(); return;
            }
            try {
              BOARD_STORES.filter(key => key !== 'meta').forEach(key => { const target = tx.objectStore(key); target.clear(); incoming[key].forEach(row => target.put(row)); });
              const metaStore = tx.objectStore('meta');
              snapshot.meta.forEach(row => metaStore.delete(row.id));
              incoming.meta.forEach(row => metaStore.put(row));
              deviceMeta.forEach(row => metaStore.put(row));
            } catch (error) { reason = error; tx.abort(); }
          };
        });
      });
    }
    async capture(verifyAssetHashes = false) {
      const snapshot = await this.transaction('readonly'), assetBlobs = [];
      snapshot.meta = snapshot.meta.filter(row => SYNCABLE_META_IDS.has(row.id));
      let totalBytes = 0;
      for (const asset of snapshot.assets) {
        if (!(asset.blob instanceof Blob)) throw new Error('Nie można odczytać kompletnego obrazu lub dokumentu z tej tablicy.');
        const cachedHash = /^[a-f0-9]{64}$/.test(asset.sha256 || '') ? asset.sha256 : '';
        const sha256 = verifyAssetHashes || !cachedHash ? await blobHash(asset.blob, this.crypto) : cachedHash;
        if (verifyAssetHashes && ((cachedHash && cachedHash !== sha256) || asset.size !== asset.blob.size || asset.mime !== asset.blob.type)) {
          throw new Error('Nie udało się zweryfikować obrazu lub dokumentu z tej tablicy. Zapisano go lokalnie bez zmian.');
        }
        totalBytes += asset.blob.size;
        assetBlobs.push({ id: asset.id, blob: asset.blob });
        Object.assign(asset, { mime: asset.mime || asset.blob.type, size: asset.blob.size, sha256 });
      }
      if (totalBytes > MAX_ASSET_TOTAL_BYTES) throw new Error('Assety biblioteki przekraczają łączny limit synchronizacji 500 MiB.');
      const manifest = { ...snapshot, assets: snapshot.assets.map(withoutBlob) };
      validateBoards(manifest);
      return { data: manifest, assetBlobs };
    }
    replace(incoming, expected, assetBlobs = []) {
      const blobs = new Map(assetBlobs.map(item => [item.id, item.blob]));
      const rows = incoming.assets.map(asset => {
        const blob = blobs.get(asset.id);
        if (!(blob instanceof Blob) || blob.size !== asset.size || blob.type !== asset.mime) throw new Error('Nie udało się pobrać kompletnej biblioteki tablic. Lokalne dane nie zostały zmienione.');
        return { ...asset, blob };
      });
      return this.transaction('readwrite', { ...incoming, assets: rows }, expected);
    }
  }
  async function digest(value, cryptoAPI, enforceLimit = true) {
    const bytes = new TextEncoder().encode(stable(manifestData(value)));
    if (enforceLimit && bytes.length > MAX_BYTES) throw new Error('Kategoria przekracza 8 MiB. Zmniejsz dane lub załączniki przed synchronizacją.');
    return Array.from(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  function mergeClocks(clocks) {
    const result = Object.create(null);
    clocks.forEach(clock => Object.keys(clock).forEach(k => { result[k] = Math.max(result[k] || 0, clock[k]); }));
    return result;
  }
  function dominates(a, b) {
    return Object.keys(b).every(k => (a[k] || 0) >= b[k]) && Object.keys(a).some(k => a[k] > (b[k] || 0));
  }
  function heads(records) {
    const candidates = records.filter(a => !records.some(b => dominates(b.vector, a.vector)));
    const unique = new Map();
    candidates.forEach(record => {
      const signature = stable({ hash: record.hash, vector: record.vector });
      if (!unique.has(signature)) unique.set(signature, record);
    });
    return [...unique.values()];
  }
  function empty(data) { return Object.values(data.local).every(v => v === null) &&
    (!has(data, 'boards') || BOARD_STORES.every(name => !data.boards[name].length)); }
  function decide(localHash, cloud, base, localEmpty) {
    if (!cloud.length) return localEmpty ? 'none' : (base ? 'conflict' : 'push');
    const hashes = new Set(cloud.map(r => r.hash));
    if (hashes.size !== 1) return 'conflict';
    const remoteHash = cloud[0].hash;
    if (localHash === remoteHash) return 'same';
    if (base && localHash === base.hash) return 'pull';
    if (base && remoteHash === base.hash) return 'push';
    if (!base && localEmpty) return 'pull';
    return 'conflict';
  }
  function validateRecord(record, category) {
    const spec = CATEGORIES[category];
    if (!object(record) || record.app !== 'InfoMatyka' || record.schema !== SYNC_SCHEMA || record.category !== category || !spec ||
        !/^[a-zA-Z0-9-]{8,80}$/.test(record.device || '') || typeof record.deviceName !== 'string' || record.deviceName.length > 60 || !object(record.vector) || !object(record.datasetSchemas) ||
        !Number.isSafeInteger(record.vector[record.device]) || record.vector[record.device] < 1 ||
        Object.keys(record.vector).length > 100 || Object.entries(record.vector).some(([k, v]) => !/^[a-zA-Z0-9-]{8,80}$/.test(k) || !Number.isSafeInteger(v) || v < 1) ||
        !object(record.data) || !object(record.data.local) || !/^[a-f0-9]{64}$/.test(record.hash || '')) {
      throw new Error('Nieobsługiwany lub uszkodzony zapis Drive. Dane lokalne pozostają zachowane.');
    }
    if (Object.keys(record.data).some(k => !['local', 'boards'].includes(k)) ||
        Object.keys(record.data.local).length !== spec.keys.length ||
        spec.keys.some(k => !has(record.data.local, k) || !DATA_REGISTRY.validate(DATA_REGISTRY.getByKey(k).id, record.data.local[k])) ||
        Object.keys(record.data.local).some(k => !spec.keys.includes(k)) ||
        Object.keys(record.datasetSchemas).length !== spec.datasets.length ||
        spec.datasets.some(id => record.datasetSchemas[id] !== DATA_REGISTRY.get(id).schema) ||
        (spec.boards ? !has(record.data, 'boards') : has(record.data, 'boards'))) throw new Error('Zapis zawiera nieprawidłowy zakres danych.');
    if (spec.boards) {
      if (record.boardSchema !== BOARD_SCHEMA) throw new Error('Wersja schematu tablic Drive nie jest obsługiwana.');
      validateBoards(record.data.boards);
    } else if (has(record, 'boardSchema')) throw new Error('Zapis zawiera schemat biblioteki poza kategorią tablic.');
    return record;
  }

  function emptyCategoryData(category) {
    const spec = CATEGORIES[category];
    const data = { local: Object.fromEntries(spec.keys.map(key => [key, null])) };
    if (spec.boards) data.boards = Object.fromEntries(BOARD_STORES.map(store => [store, []]));
    return data;
  }

  function resolveDriveConflicts(result) {
    const choices = Object.fromEntries(result.conflicts.map(conflict => [conflict.dataset + ':' + conflict.path, 'remote']));
    return MERGE_CORE.resolveConflicts(result, choices);
  }

  function mergeCategory(base, local, remote, category, now = Date.now, options = {}) {
    const spec = CATEGORIES[category], merged = { local: Object.create(null) }, conflicts = [];
    const stats = { addedLocal: 0, addedRemote: 0, updatedLocal: 0, updatedRemote: 0, deleted: 0, conflicts: 0 };
    for (const key of spec.keys) {
      const dataset = DATA_REGISTRY.getByKey(key);
      const isProgressState = dataset.id === 'progress.state';
      const baselineState = object(base.local[key]) ? base.local[key] : object(remote.local[key]) ? remote.local[key] : local.local[key];
      const eventsKey = DATA_REGISTRY.get('progress.events').key;
      const baselineEvents = object(base.local[key]) ? base.local[eventsKey] : object(remote.local[key]) ? remote.local[eventsKey] : local.local[eventsKey];
      const xpBaseline = isProgressState ? progressBaseline(baselineState, baselineEvents) : 0;
      const hasProgressStateModel = isProgressState && [base.local[key], local.local[key], remote.local[key]].some(value =>
        object(value) && (has(value, 'xp') || has(value, 'xpBaseline') || object(value.stats) && has(value.stats, 'totalXp')));
      let mergeBase = base.local[key], mergeLocal = local.local[key], mergeRemote = remote.local[key];
      if (options.emptyBaseline) {
        const values = [mergeBase, mergeLocal, mergeRemote];
        if (['entity-three-way', 'event-union', 'set-union'].includes(dataset.syncStrategy) && values.some(Array.isArray)) {
          mergeBase = Array.isArray(mergeBase) ? mergeBase : [];
          mergeLocal = Array.isArray(mergeLocal) ? mergeLocal : [];
          mergeRemote = Array.isArray(mergeRemote) ? mergeRemote : [];
        } else if (values.some(object)) {
          mergeBase = object(mergeBase) ? mergeBase : {};
          mergeLocal = object(mergeLocal) ? mergeLocal : {};
          mergeRemote = object(mergeRemote) ? mergeRemote : {};
        }
      }
      if (isProgressState) {
        mergeBase = withoutDerivedProgress(mergeBase);
        mergeLocal = withoutDerivedProgress(mergeLocal);
        mergeRemote = withoutDerivedProgress(mergeRemote);
      }
      const result = MERGE_CORE.mergeThreeWay(mergeBase, mergeLocal, mergeRemote, {
        dataset: dataset.id, strategy: dataset.syncStrategy, now
      });
      if (hasProgressStateModel && object(result.merged)) result.merged.xpBaseline = xpBaseline;
      if (!DATA_REGISTRY.validate(dataset.id, result.merged)) {
        throw new Error('Scalony wynik „' + dataset.label + '” nie przeszedł walidacji.');
      }
      merged.local[key] = result.merged;
      conflicts.push(...result.conflicts.map(conflict => ({ ...conflict, displayPath: conflict.path,
        path: '/local/' + key + conflict.path })));
      for (const name of Object.keys(stats)) stats[name] += result.stats[name] || 0;
    }
    if (category === 'progress') {
      const stateKey = DATA_REGISTRY.get('progress.state').key;
      const eventKey = DATA_REGISTRY.get('progress.events').key;
      const state = merged.local[stateKey];
      const progressValues = [base.local[stateKey], local.local[stateKey], remote.local[stateKey]];
      const hasXpModel = (Array.isArray(merged.local[eventKey]) && merged.local[eventKey].length > 0) ||
        progressValues.some(value => object(value) && (has(value, 'xp') || has(value, 'xpBaseline') ||
          object(value.stats) && has(value.stats, 'totalXp')));
      if (hasXpModel && object(state)) {
        const baseline = Number(state.xpBaseline) || 0;
        const events = Array.isArray(merged.local[eventKey]) ? merged.local[eventKey] : [];
        const xp = baseline + events.reduce((total, event) => total + (Number(event.deltaXp) || 0), 0);
        state.xp = xp;
        state.stats = { ...(state.stats || {}), totalXp: xp };
      }
    }
    if (spec.boards) {
      const emptyBoards = Object.fromEntries(BOARD_STORES.map(name => [name, []]));
      const result = MERGE_CORE.mergeThreeWay(base.boards || emptyBoards, local.boards || emptyBoards, remote.boards || emptyBoards, {
        dataset: 'boards.library', strategy: 'nested-entity-three-way', now
      });
      validateBoards(result.merged);
      merged.boards = result.merged;
      conflicts.push(...result.conflicts);
      for (const name of Object.keys(stats)) stats[name] += result.stats[name] || 0;
    }
    stats.conflicts = conflicts.length;
    return { merged, conflicts, stats };
  }

  class DriveTransport {
    constructor(fetcher, token, onUnauthorized) { this.fetcher = fetcher; this.token = token; this.onUnauthorized = onUnauthorized; }
    async request(path, options = {}, responseType = 'json') {
      const auth = this.token();
      if (!auth || Date.now() >= auth.expiresAt) throw new Error('Połączenie wygasło. Kliknij „Połącz z Google Drive”.');
      const { timeoutMs = 25000, ...requestOptions } = options;
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await this.fetcher('https://www.googleapis.com/' + path, { ...requestOptions, signal: controller.signal,
            headers: { ...options.headers, Authorization: 'Bearer ' + auth.accessToken } });
        } finally { clearTimeout(timer); }
        if (!(response.status === 429 || response.status >= 500) || options.method === 'POST') break;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 300));
      }
      if (!response.ok) {
        if (response.status === 401) { if (this.onUnauthorized) this.onUnauthorized(); throw new Error('Google cofnęło lub zakończyło dostęp. Połącz ponownie.'); }
        if (response.status === 412) throw new Error('Dane Google Drive zmieniły się po porównaniu. Sprawdź aktualne wersje ponownie.');
        if (response.status === 403) throw new Error('Google odmówiło dostępu. Sprawdź zgodę, Drive API, limit i zasady konta szkolnego.');
        if (response.status === 429 || response.status >= 500) throw new Error('Google Drive jest chwilowo niedostępny. Spróbuj później.');
        throw new Error('Nie udało się odczytać lub zapisać danych Drive (HTTP ' + response.status + ').');
      }
      if (responseType === 'blob') return response.blob();
      const content = await response.text();
      if (new TextEncoder().encode(content).length > MAX_BYTES + 100000) throw new Error('Zapis Drive jest zbyt duży.');
      const data = content ? JSON.parse(content) : null;
      return responseType === 'file' ? { data, etag: response.headers.get('ETag') } : data;
    }
    async list(category) {
      const files = []; let page;
      do {
        const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '100',
          fields: 'nextPageToken,files(id,name,size,modifiedTime,version,headRevisionId,appProperties)',
          q: "trashed = false and appProperties has { key='imSync' and value='v3' } and appProperties has { key='category' and value='" + category + "' }" });
        if (page) params.set('pageToken', page);
        const result = await this.request('drive/v3/files?' + params);
        files.push(...(result.files || [])); page = result.nextPageToken;
        if (files.length > MAX_FILES) throw new Error('Przekroczono limit 100 plików urządzeń w kategorii. Synchronizacja zatrzymana.');
      } while (page);
      return files;
    }
    async read(file) { return this.request('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media', {}, 'file'); }
    async listBoardAssets() {
      const files = []; let page;
      do {
        const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000',
          fields: 'nextPageToken,files(id,name,size,mimeType,modifiedTime,version,appProperties)',
          q: "trashed = false and appProperties has { key='imSync' and value='v3' } and appProperties has { key='type' and value='boardAsset' }" });
        if (page) params.set('pageToken', page);
        const result = await this.request('drive/v3/files?' + params);
        files.push(...(result.files || [])); page = result.nextPageToken;
        if (files.length > 10000) throw new Error('Przekroczono limit zasobów tablic na Drive. Synchronizacja zatrzymana.');
      } while (page);
      return files;
    }
    readAsset(file) { return this.request('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media', { timeoutMs: 180000 }, 'blob'); }
    async writeAsset(asset, blob) {
      const boundary = 'im_asset_' + asset.sha256.slice(0, 24);
      const metadata = { name: 'infomatyka-board-asset-' + asset.sha256,
        mimeType: asset.mime, parents: ['appDataFolder'], appProperties: {
        imSync: 'v3', type: 'boardAsset', assetId: asset.id, sha256: asset.sha256, mime: asset.mime
        } };
      const body = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
        '\r\n--' + boundary + '\r\nContent-Type: ' + asset.mime + '\r\n\r\n',
        blob, '\r\n--' + boundary + '--'
      ]);
      return this.request('upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,appProperties', {
        method: 'POST', timeoutMs: 180000, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body
      });
    }
    async write(record, ownFiles) {
      const content = stable(record);
      if (new TextEncoder().encode(content).length > MAX_BYTES) throw new Error('Zapis przekracza 8 MiB.');
      if (ownFiles.length > 1) throw new Error('Znaleziono kilka plików nagłówka tego urządzenia na Drive. Synchronizacja została zatrzymana; żaden plik nie został zmieniony.');
      if (ownFiles.length) {
        // Fresh manifest/hash/version checks run immediately before this update. Keep the
        // HTTP precondition when the browser exposes ETag, but do not block Drive v3
        // clients that expose its monotonically increasing version only.
        await this.request('upload/drive/v3/files/' + encodeURIComponent(ownFiles[0].id) + '?uploadType=media', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(ownFiles[0].etag ? { 'If-Match': ownFiles[0].etag } : {}) }, body: content });
        return;
      }
      const boundary = 'im_' + record.device;
      const metadata = { name: 'infomatyka-v3-' + record.category + '-' + record.device + '.json',
        mimeType: 'application/json', parents: ['appDataFolder'],
        appProperties: { imSync: 'v3', category: record.category, device: record.device } };
      const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--' + boundary + '--';
      // No automatic POST retry: if the response is lost, the next sync re-lists files.
      await this.request('upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    }
  }

  class SyncEngine {
    constructor(options) { Object.assign(this, options); }
    checkpointKey(category) { return 'infomatyka-sync-checkpoint-' + this.account + '-' + category; }
    baseKey(datasetId) { return dataBaseKey(this.account, datasetId); }
    async loadBase(category) {
      if (!this.bases) return null;
      const spec = CATEGORIES[category], data = { local: Object.create(null) };
      for (const datasetId of spec.datasets) {
        const dataset = DATA_REGISTRY.get(datasetId), stored = await this.bases.getItem(this.baseKey(datasetId));
        if (!stored || stored.schema !== dataset.schema || !has(stored, 'value')) return null;
        if (dataset.key) data.local[dataset.key] = stored.value;
        else if (dataset.id === 'boards.library') data.boards = stored.value;
      }
      return data;
    }
    async saveBase(category, data, vector, hash) {
      if (!this.bases) throw new Error('Nie załadowano lokalnego magazynu wspólnej bazy synchronizacji.');
      const spec = CATEGORIES[category], before = [], writes = [];
      const durableData = manifestData(data);
      for (const datasetId of spec.datasets) {
        const dataset = DATA_REGISTRY.get(datasetId), value = dataset.key ? durableData.local[dataset.key] : durableData.boards;
        const key = this.baseKey(datasetId);
        before.push({ key, value: await this.bases.getItem(key) });
        writes.push({ key, value: { schema: dataset.schema, value } });
      }
      try {
        for (const write of writes) await this.bases.setItem(write.key, write.value);
        this.storage.setItem(this.checkpointKey(category), JSON.stringify({ hash, vector }));
      } catch (error) {
        for (const prior of before.reverse()) {
          try { if (prior.value === null) await this.bases.removeItem(prior.key); else await this.bases.setItem(prior.key, prior.value); } catch (_) { }
        }
        throw new Error('Nie zapisano checkpointu. Kopie baz pozostają niezmienione; ponów synchronizację. ' + error.message);
      }
    }
    async capture(category, verifyBoardAssets = false) {
      const data = { local: Object.create(null) }, spec = CATEGORIES[category];
      const base = await this.loadBase(category);
      for (const key of spec.keys) {
        const dataset = DATA_REGISTRY.getByKey(key), raw = await DATA_REGISTRY.capture(dataset.id, { storage: this.storage });
        const value = raw === null ? null : decodeStoredValue({ getItem: () => raw }, key);
        if (!DATA_REGISTRY.validate(dataset.id, value)) throw new Error('Dane „' + dataset.label + '” nie przechodzą walidacji.');
        data.local[key] = base && has(base.local, key) ? restoreTombstones(value, base.local[key]) : value;
      }
      if (spec.boards) {
        if (!this.boards) throw new Error('Nie załadowano pamięci tablic.');
        const snapshot = await this.boards.capture(verifyBoardAssets);
        data.boards = base && base.boards ? restoreTombstones(snapshot.data, base.boards) : snapshot.data;
        data.boardAssetBlobs = snapshot.assetBlobs;
      }
      return data;
    }
    // Oversized local data can still be compared/backed up and replaced by a smaller cloud copy.
    async hash(data) { return digest(data, this.crypto, false); }
    async backup(category, data, reason = 'Przed synchronizacją') {
      const key = this.account + ':' + category;
      const copies = await this.backups.getItem(key) || [];
      const copy = { at: new Date().toISOString(), category, reason, data };
      await this.backups.setItem(key, [copy, ...copies].slice(0, 5));
    }
    async apply(category, incoming, before, backupReason = 'Przed pobraniem z Drive', skipBackup = false) {
      if (this.beforeApply) await this.beforeApply(category);
      // Fail closed if a durable rollback copy cannot be stored (e.g. quota full).
      if (!skipBackup) await this.backup(category, before, backupReason);
      if (await this.hash(await this.capture(category)) !== await this.hash(before)) throw new Error('Dane zmieniły się podczas pobierania. Spróbuj ponownie.');
      if (this.beforeApply) await this.beforeApply(category);
      if (this.onApplyStart) this.onApplyStart(category);
      let applied = false;
      try {
      const spec = CATEGORIES[category];
      const writeLocal = data => spec.keys.forEach(k => {
        const dataset = DATA_REGISTRY.getByKey(k), value = data.local[k];
        const serialized = value === null ? null : encodeStoredValue(stripTombstones(value));
        DATA_REGISTRY.apply(dataset.id, serialized, { storage: this.storage });
      });
      try {
        // Synchronous localStorage part cannot interleave within this tab.
        writeLocal(incoming);
        if (spec.boards) await this.boards.replace(projectBoardTombstones(incoming.boards),
          projectBoardTombstones(before.boards), incoming.boardAssetBlobs);
      } catch (error) {
        try {
          writeLocal(before);
        } catch (_) { throw new Error('Pamięć urządzenia jest pełna. Kopia sprzed zmiany pozostaje w „Pobierz kopie lokalne”.'); }
        throw error;
      }
      applied = true;
      if (this.onApplied) this.onApplied(category);
      } finally { if (this.onApplyEnd) this.onApplyEnd(category, applied); }
    }
    async inspect(category, options = {}) {
      const local = await this.capture(category, options.verifyBoardAssets === true), localHash = await this.hash(local);
      const files = await this.transport.list(category), records = [];
      for (const file of files) {
        const response = await this.transport.read(file), record = validateRecord(response.data, category);
        if (file.appProperties.device !== record.device || record.hash !== await this.hash(record.data)) throw new Error('Zapis Drive nie przeszedł kontroli integralności.');
        file.etag = response.etag;
        records.push({ ...record, fileId: file.id, etag: response.etag, driveVersion: file.version || null,
          headRevisionId: file.headRevisionId || null,
          bytes: byteSize(record.data), fileBytes: Number(file.size) || byteSize(record), savedAt: file.modifiedTime || record.updatedAt });
      }
      const cloud = heads(records);
      const filesByDevice = new Map();
      records.forEach(record => filesByDevice.set(record.device, [...(filesByDevice.get(record.device) || []), record.fileId]));
      const duplicateDevices = [...filesByDevice].filter(([, ids]) => ids.length > 1).map(([device, ids]) => ({ device, fileIds: ids }));
      const signature = stable(records.map(r => ({ id: r.fileId, hash: r.hash, vector: r.vector, version: r.driveVersion,
        etag: r.etag, modifiedTime: r.savedAt, size: r.fileBytes, headRevisionId: r.headRevisionId || null }))
        .sort((a, b) => a.id.localeCompare(b.id)));
      let checkpoint = null;
      try { checkpoint = JSON.parse(this.storage.getItem(this.checkpointKey(category))); } catch (_) { /* recover with a conflict */ }
      const baseData = checkpoint ? await this.loadBase(category) : null;
      const base = checkpoint ? { ...checkpoint, data: baseData } : null;
      const baseCorrupt = !!checkpoint && (!baseData || await this.hash(baseData) !== checkpoint.hash);
      let mergePreview = null, remoteData = null, action;
      if (cloud.length) {
        const hasUsableBase = !!baseData && !baseCorrupt;
        const mergeBase = hasUsableBase ? baseData : emptyCategoryData(category);
        const mergeOptions = { emptyBaseline: !hasUsableBase };
        remoteData = manifestData(cloud[0].data);
        const remoteConflicts = [];
        for (const record of cloud.slice(1)) {
          const remoteMerge = mergeCategory(mergeBase, remoteData, manifestData(record.data), category, Date.now, mergeOptions);
          remoteData = resolveDriveConflicts(remoteMerge).merged;
          remoteConflicts.push(...remoteMerge.conflicts);
        }
        mergePreview = mergeCategory(mergeBase, manifestData(local), remoteData, category, Date.now, mergeOptions);
        mergePreview.conflicts.unshift(...remoteConflicts);
        mergePreview.stats.conflicts = mergePreview.conflicts.length;
        const mergedHash = await this.hash(mergePreview.merged);
        const remoteHash = await this.hash(remoteData);
        mergePreview.hash = mergedHash;
        action = duplicateDevices.length || baseCorrupt || mergePreview.conflicts.length ? 'conflict' :
          mergedHash === localHash && mergedHash === remoteHash ? 'same' :
          mergedHash === localHash ? 'push' : mergedHash === remoteHash ? 'pull' : 'merge';
      } else action = decide(localHash, cloud, base, empty(local));
      const dates = local.boards ? [
        ...local.boards.boardIndex.flatMap(row => [row.updatedAt, row.deletedAt, row.createdAt]),
        ...local.boards.folders.flatMap(row => [row.updatedAt, row.createdAt]),
        ...local.boards.assets.map(asset => asset.createdAt)
      ].filter(value => Number.isFinite(value) && value > 0) : [];
      const savedAt = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
      const vector = mergeClocks([...cloud.map(r => r.vector), ...(base && object(base.vector) ? [base.vector] : [])]);
      const uploadBytes = byteSize({ app: 'InfoMatyka', schema: SYNC_SCHEMA, ...(CATEGORIES[category].boards ? { boardSchema: BOARD_SCHEMA } : {}),
        category, datasetSchemas: Object.fromEntries(CATEGORIES[category].datasets.map(id => [id, DATA_REGISTRY.get(id).schema])), device: this.device,
        updatedAt: new Date().toISOString(), vector, hash: mergePreview ? mergePreview.hash : localHash, data: manifestData(mergePreview ? mergePreview.merged : local) });
      const localCounts = local.boards ? { boards: local.boards.boardIndex.filter(row => !row.deletedAt && !isDeletedRow(row)).length,
        folders: local.boards.folders.filter(row => !isDeletedRow(row)).length,
        assets: local.boards.assets.filter(row => !isDeletedRow(row)).length,
        assetBytes: local.boards.assets.reduce((sum, asset) => sum + (isDeletedRow(asset) ? 0 : asset.size), 0) } : null;
      return { category, action, local, localHash, signature, cloud, files, base, mergePreview, remoteData, duplicateDevices, baseCorrupt, fileCount: files.length,
        localVersion: { bytes: byteSize(local), uploadBytes, savedAt, empty: empty(local), counts: localCounts,
          device: this.device, vector: base && object(base.vector) ? base.vector : { [this.device]: 0 } } };
    }
    async assertReviewUnchanged(review) {
      const latest = await this.inspect(review.category, { verifyBoardAssets: true });
      if (latest.localHash !== review.localHash || latest.signature !== review.signature) {
        throw new Error('Dane lokalne lub Google Drive zmieniły się po porównaniu. Niczego nie zmieniono. Sprawdź aktualne wersje ponownie.');
      }
      return latest;
    }
    async prepareBoardAssets(data, onProgress, preferredBlobs = []) {
      if (!data.boards) return data;
      const files = await this.transport.listBoardAssets(), blobs = [];
      const localBlobs = new Map(preferredBlobs.map(item => [item.id, item.blob]));
      let totalBytes = 0;
      const activeAssets = data.boards.assets.filter(asset => !isDeletedRow(asset));
      for (let index = 0; index < activeAssets.length; index++) {
        const asset = activeAssets[index];
        let verified = null;
        const localBlob = localBlobs.get(asset.id);
        if (localBlob && await validateAssetBlob(asset, localBlob, this.crypto)) verified = localBlob;
        const matches = files.filter(candidate => candidate.appProperties.sha256 === asset.sha256 &&
          candidate.appProperties.mime === asset.mime && Number(candidate.size) === asset.size);
        for (const file of verified ? [] : matches) {
          const blob = await this.transport.readAsset(file);
          if (await validateAssetBlob(asset, blob, this.crypto)) { verified = blob; break; }
        }
        if (!verified) {
          throw new Error('Nie udało się pobrać kompletnej biblioteki tablic. Lokalne dane nie zostały zmienione.');
        }
        totalBytes += verified.size;
        if (totalBytes > MAX_ASSET_TOTAL_BYTES) throw new Error('Pobrane materiały przekraczają łączny limit 500 MiB. Lokalne dane nie zostały zmienione.');
        blobs.push({ id: asset.id, blob: verified });
        if (onProgress) onProgress('Pobieranie assetów', index + 1, activeAssets.length);
      }
      return { ...data, boardAssetBlobs: blobs };
    }
    async uploadBoardAssets(data, onProgress) {
      if (!data.boards) return;
      const blobs = new Map((data.boardAssetBlobs || []).map(item => [item.id, item.blob]));
      const remoteFiles = await this.transport.listBoardAssets();
      const activeAssets = data.boards.assets.filter(asset => !isDeletedRow(asset));
      for (let index = 0; index < activeAssets.length; index++) {
        const asset = activeAssets[index], blob = blobs.get(asset.id);
        if (!(blob instanceof Blob) || blob.size !== asset.size || blob.type !== asset.mime || await blobHash(blob, this.crypto) !== asset.sha256) {
          throw new Error('Zasób biblioteki zmienił się po porównaniu. Nie wysłano manifestu.');
        }
        let present = false;
        const matches = remoteFiles.filter(file => file.appProperties.sha256 === asset.sha256 &&
          file.appProperties.mime === asset.mime && Number(file.size) === asset.size);
        for (const file of matches) if (await validateAssetBlob(asset, await this.transport.readAsset(file), this.crypto)) { present = true; break; }
        if (!present) remoteFiles.push(await this.transport.writeAsset(asset, blob));
        if (onProgress) onProgress('Wysyłanie assetów', index + 1, activeAssets.length);
      }
    }
    async sync(category, resolution) {
      const review = await this.inspect(category, { verifyBoardAssets: true });
      const { local, localHash, files, cloud, signature, base } = review;
      if (review.duplicateDevices.length) return { ...review, action: 'conflict' };
      if (!resolution) return review;
      if (resolution.signature !== signature || resolution.localHash !== localHash) return { ...review, action: 'conflict' };
      const source = resolution.source;
      if (!['merge', 'local', 'cloud'].includes(source)) return { ...review, action: 'conflict' };
      if (source === 'merge' && ((!review.mergePreview && !(cloud.length === 0 && review.action === 'push')) ||
          review.baseCorrupt || ['same', 'none'].includes(review.action))) {
        return { ...review, action: 'conflict' };
      }
      if (source === 'local' && ['same', 'none'].includes(review.action)) return { ...review, action: 'conflict' };
      if (review.action === 'same' || review.action === 'none') return { category, action: review.action };

      const action = source === 'merge' ? 'merge' : source === 'local' ? 'push' : 'pull';
      const ownFile = files.find(file => file.appProperties.device === this.device);
      const ownFiles = ownFile ? [ownFile] : [];
      if ((action !== 'pull' || source === 'cloud') && !ownFiles.length && files.length >= MAX_FILES) throw new Error('Osiągnięto limit 100 plików urządzeń. Nowe urządzenie nie może dodać zapisu w tej kategorii.');
      if (await this.hash(await this.capture(category)) !== localHash) throw new Error('Dane lokalne zmieniły się w trakcie synchronizacji. Spróbuj ponownie.');
      let vector = mergeClocks([...cloud.map(r => r.vector), ...(base && object(base.vector) ? [base.vector] : [])]);
      let incoming;
      let mergeResult = review.mergePreview;
      if (source === 'merge' && mergeResult) {
        if (mergeResult.conflicts.length) mergeResult = resolveDriveConflicts(mergeResult);
        incoming = { ...manifestData(mergeResult.merged), boardAssetBlobs: local.boardAssetBlobs || [] };
        incoming = await this.prepareBoardAssets(incoming, this.onProgress, local.boardAssetBlobs || []);
      } else if (source === 'merge' && action === 'merge') {
        incoming = local;
      } else if (source === 'cloud') {
        incoming = await this.prepareBoardAssets(review.remoteData || emptyCategoryData(category), this.onProgress, local.boardAssetBlobs || []);
      } else if (action === 'pull') {
        incoming = await this.prepareBoardAssets((review.remoteData || cloud[0].data), this.onProgress, local.boardAssetBlobs || []);
      } else incoming = local;

      const nextHash = await this.hash(incoming);
      if (!resolution.skipBackup) {
        if (cloud.length) {
          const remoteBackup = await this.prepareBoardAssets(review.remoteData || cloud[0].data, null, local.boardAssetBlobs || []);
          await this.backup(category, remoteBackup, 'Google Drive przed zmianą');
        }
        await this.backup(category, local, 'Dane lokalne przed synchronizacją');
      }
      await this.assertReviewUnchanged(review);

      // A deliberate download also publishes a new head on this device. Its clock
      // dominates every prior head so the chosen snapshot becomes the shared baseline.
      if (action !== 'pull' || source === 'cloud') {
        vector[this.device] = (vector[this.device] || 0) + 1;
        const record = { app: 'InfoMatyka', schema: SYNC_SCHEMA,
          ...(CATEGORIES[category].boards ? { boardSchema: BOARD_SCHEMA } : {}), category,
          datasetSchemas: Object.fromEntries(CATEGORIES[category].datasets.map(id => [id, DATA_REGISTRY.get(id).schema])),
          device: this.device, deviceName: this.deviceName || ('Urządzenie ' + this.device.slice(-4)),
          updatedAt: new Date().toISOString(), vector, hash: nextHash, data: manifestData(incoming) };
        validateRecord(record, category);
        if (byteSize(record) > MAX_BYTES) throw new Error('Zapis wraz z opisem przekracza limit 8 MiB. Zmniejsz dane lub załączniki.');
        await this.uploadBoardAssets(incoming, this.onProgress);
        await this.assertReviewUnchanged(review);
        if (this.onProgress) this.onProgress('Zapisywanie manifestu…', 0, 0);
        await this.transport.write(record, ownFiles);
      }
      await this.apply(category, incoming, local, 'Lokalnie przed zastosowaniem połączonego wyniku', true);
      await this.saveBase(category, incoming, vector, nextHash);
      const after = await this.inspect(category);
      if (!['same', 'none'].includes(after.action)) {
        throw new Error('Drive zmienił się w trakcie zatwierdzania. Zachowano kopię lokalną; ponownie sprawdź i połącz aktualne wersje.');
      }
      return { category, action };
    }
  }
  // Export the actual engine for deterministic integration tests, without initializing browser UI.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MODULE_VERSION, SYNC_SCHEMA, BOARD_SCHEMA, BOARD_DB_VERSION, CATEGORIES, SyncEngine, BoardStore, DriveTransport, MAX_BYTES, MAX_FILES,
      DATA_REGISTRY, MERGE_CORE, byteSize, stable, digest, dominates, mergeClocks, heads, decide, mergeCategory, validateRecord,
      projectBoardTombstones,
      makeRecoveryArchive, readRecoveryArchive }; return;
  }

  const SESSION_KEY = 'infomatyka-sync-session';
  const EDIT_PREFIX = 'infomatyka-sync-edit-';
  const HYDRATION_PREFIX = 'infomatyka-sync-hydration-';
  const SYNC_CATEGORIES = Object.keys(CATEGORIES);
  const tabId = root.crypto.randomUUID ? root.crypto.randomUUID() : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const keyCategory = new Map(Object.entries(CATEGORIES).flatMap(([category, spec]) => spec.keys.map(key => [key, category])));
  const internalWrites = new Set(), loadedEpochs = Object.create(null), previousEpochs = Object.create(null);
  Object.keys(CATEGORIES).forEach(category => { loadedEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category); });
  let pageEdited = false, needsReload = false, refreshTimer = null, preparePromise = null;
  let sessionRequest = null, connectionChannel = null;
  let token = null, account = null, ready = false, busy = false, authorizing = false, client = null, gisPromise = null;
  let engine, backupStore, baseStore, comparisons = [], recovery = [], operationErrors = [], panel, notice = '', applied = false, afterAuth = null, pendingDirection = null;
  let recoveryAccountSelection = '';
  let progressMessage = '';
  let prefs = { connectionActive: true, boundAccount: '', accountEmail: '', deviceName: '' };
  try {
    const current = root.localStorage.getItem(SETTINGS_KEY);
    const stored = JSON.parse(current || '{}');
    prefs = { ...prefs,
      connectionActive: stored.connectionActive !== false,
      boundAccount: typeof stored.boundAccount === 'string' ? stored.boundAccount : '',
      accountEmail: typeof stored.accountEmail === 'string' ? stored.accountEmail : '',
      deviceName: typeof stored.deviceName === 'string' ? stored.deviceName : '' };
  } catch (_) { }
  const config = root.InfoMatykaDriveConfig || {};
  const configured = typeof config.clientId === 'string' && /^[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId);
  const connected = () => !!token && Date.now() < token.expiresAt && !!account;
  function savePrefs() { prefs.preferenceSchema = 4; root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); }
  function mergeSavedPrefs(saved) {
    prefs = { ...prefs,
      connectionActive: saved.connectionActive !== false,
      boundAccount: typeof saved.boundAccount === 'string' ? saved.boundAccount : '',
      accountEmail: typeof saved.accountEmail === 'string' ? saved.accountEmail : '',
      deviceName: typeof saved.deviceName === 'string' ? saved.deviceName : '' };
  }
  function categoryStateKey(category) { return STATE_PREFIX + (prefs.boundAccount || 'unbound') + '-' + category; }
  function categoryState(category) {
    const defaults = { localDirty: false, remoteChanged: false, lastSyncedHash: null, lastSyncedVector: null,
      lastRemoteVersion: null, lastSuccessfulSyncAt: null, lastCheckedAt: null, lastLocalChangeAt: null };
    try { return { ...defaults, ...JSON.parse(root.localStorage.getItem(categoryStateKey(category)) || '{}') }; }
    catch (_) { return defaults; }
  }
  function saveCategoryState(category, state) {
    try { root.localStorage.setItem(categoryStateKey(category), JSON.stringify(state)); } catch (_) { /* State metadata must not interrupt data saves. */ }
  }
  function recordLocalChange(category) {
    const state = categoryState(category);
    state.localDirty = true; state.lastLocalChangeAt = new Date().toISOString();
    saveCategoryState(category, state);
  }
  function recordInspectionState(reviews) {
    const checkedAt = new Date().toISOString();
    reviews.forEach(review => {
      if (review.error) return;
      const state = categoryState(review.category), base = review.base;
      state.localDirty = base ? review.localHash !== base.hash : !review.localVersion.empty;
      if (['same', 'none'].includes(review.action)) state.localDirty = false;
      state.remoteChanged = review.cloud.length ? review.cloud.some(record => base ? record.hash !== base.hash || stable(record.vector) !== stable(base.vector) : review.action !== 'same') : !!base;
      state.lastRemoteVersion = review.cloud.length === 1 ? review.cloud[0].driveVersion : review.cloud.map(record => ({ device: record.device, version: record.driveVersion }));
      state.lastCheckedAt = checkedAt;
      if (base) { state.lastSyncedHash = base.hash; state.lastSyncedVector = base.vector; }
      saveCategoryState(review.category, state);
    });
  }
  function recordSuccessfulSync(review, result, remoteRecord) {
    let checkpoint = null;
    try { checkpoint = JSON.parse(root.localStorage.getItem(engine.checkpointKey(review.category))); } catch (_) { }
    const state = categoryState(review.category);
    state.localDirty = false; state.remoteChanged = false;
    state.lastSyncedHash = checkpoint && checkpoint.hash || review.localHash;
    state.lastSyncedVector = checkpoint && checkpoint.vector || null;
    state.lastRemoteVersion = result.action === 'pull' && remoteRecord ? remoteRecord.driveVersion : null;
    state.lastSuccessfulSyncAt = new Date().toISOString();
    saveCategoryState(review.category, state);
  }
  function getBackupStore() {
    if (!backupStore && root.localforage && root.localforage.createInstance) {
      backupStore = root.localforage.createInstance({ name: 'infomatyka-sync-recovery', storeName: 'copies' });
    }
    return backupStore;
  }
  function getBaseStore() {
    if (!baseStore && root.localforage && root.localforage.createInstance) {
      baseStore = root.localforage.createInstance({ name: BASE_STORE_NAME, storeName: 'datasets' });
    }
    return baseStore;
  }
  function notifyBoardsChanged() {
    root.dispatchEvent(new Event('infomatyka-boards-changed'));
    if (root.BroadcastChannel) { const channel = new root.BroadcastChannel('infomatyka_boards'); channel.postMessage('changed'); channel.close(); }
  }
  function clearSession() { try { root.sessionStorage.removeItem(SESSION_KEY); } catch (_) { } }
  function saveSession() {
    try { root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, clientId: config.clientId, accountId: account.permissionId })); } catch (_) { }
  }
  function text(tag, value, className) { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; }
  function loadGIS() {
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
      const timeout = setTimeout(() => reject(new Error('Nie udało się załadować logowania Google. Sprawdź blokady skryptów.')), 20000);
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error('Nie udało się załadować logowania Google.')); };
      document.head.appendChild(script);
    }).catch(e => { gisPromise = null; throw e; });
    return gisPromise;
  }
  const transport = new DriveTransport(root.fetch.bind(root), () => token, () => { token = null; clearSession(); });
  function disconnect(persist = true) {
    token = null; account = null; engine = null; comparisons = []; recovery = []; operationErrors = []; pendingDirection = null; afterAuth = null;
    prefs.connectionActive = false; if (persist) savePrefs(); clearSession();
    needsReload = false;
    Object.keys(CATEGORIES).forEach(category => { loadedEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category); });
    notice = 'Odłączono na tym urządzeniu. Dane na Drive pozostają zachowane.'; render();
  }
  function initializeAccount(user) {
    try {
      const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY));
      if (latest && (!latest.boundAccount || latest.boundAccount === user.permissionId)) mergeSavedPrefs(latest);
    } catch (_) { }
    account = user; recoveryAccountSelection = user.permissionId; comparisons = []; recovery = []; operationErrors = []; pendingDirection = null;
    prefs.boundAccount = user.permissionId; prefs.accountEmail = user.emailAddress || ''; prefs.connectionActive = true; savePrefs(); saveSession();
    const device = root.localStorage.getItem(DEVICE_KEY) || root.crypto.randomUUID();
    root.localStorage.setItem(DEVICE_KEY, device);
    backupStore = getBackupStore();
    baseStore = getBaseStore();
    engine = new SyncEngine({ storage: root.localStorage, bases: baseStore, backups: backupStore,
      boards: new BoardStore(root.indexedDB, root.crypto, notifyBoardsChanged), crypto: root.crypto, transport, device, deviceName: prefs.deviceName || '', account: user.permissionId,
      beforeApply: category => {
        if (!prefs.connectionActive || !connected() || account.permissionId !== user.permissionId) {
          const error = new Error('Połączenie zostało zakończone. Dane lokalne pozostają zachowane.'); error.code = 'DRIVE_DISCONNECTED'; throw error;
        }
        if (category === 'boards' && (pageEdited || otherPageEditing())) {
          const error = new Error('Zamknij aktywnie edytowane karty tablic i porównaj ponownie. Ich niezapisane zmiany muszą pozostać bezpieczne.'); error.code = 'DRIVE_EDITING'; throw error;
        }
      },
      onApplyStart: category => {
        internalWrites.add(category); previousEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category);
        const epoch = JSON.stringify({ tab: tabId, at: Date.now(), account: user.permissionId, done: false });
        loadedEpochs[category] = epoch; root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
      },
      onApplyEnd: (category, succeeded) => {
        if (!succeeded) {
          const epoch = previousEpochs[category];
          if (epoch === null) root.localStorage.removeItem(HYDRATION_PREFIX + category); else root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
          loadedEpochs[category] = epoch;
        } else {
          const epoch = JSON.stringify({ tab: tabId, at: Date.now(), account: user.permissionId, done: true });
          loadedEpochs[category] = epoch; root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
        }
        internalWrites.delete(category);
      },
      onApplied: category => {
        applied = true; if (!panel) needsReload = true;
        if (category === 'progress') root.dispatchEvent(new Event('infomatyka_progress_updated'));
        root.dispatchEvent(new CustomEvent('infomatyka_drive_applied', { detail: { category } }));
      },
      onProgress: (phase, current, total) => { progressMessage = total ? `${phase} ${current}/${total}…` : phase; render(); }
    });
    if (pageEdited) renewEditLease();
  }
  async function identifyAccount() {
    const about = await transport.request('drive/v3/about?fields=user(permissionId,emailAddress,displayName)');
    if (!about.user || !about.user.permissionId) throw new Error('Nie udało się ustalić właściciela Dysku.');
    return about.user;
  }
  async function receiveToken(response) {
    const continuation = afterAuth; afterAuth = null;
    try {
      if (response.error || !response.access_token || !root.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) throw new Error('Nie przyznano dostępu do danych aplikacji na Drive.');
      const lifetime = Number(response.expires_in);
      if (!Number.isFinite(lifetime) || lifetime <= 30) throw new Error('Google nie przyznało ważnego czasu połączenia. Spróbuj ponownie.');
      token = { accessToken: response.access_token, expiresAt: Date.now() + lifetime * 1000 - 30000 };
      const user = await identifyAccount();
      if (prefs.boundAccount && prefs.boundAccount !== user.permissionId) {
        if (!root.confirm('Wybrano inne konto Google: ' + (user.emailAddress || user.displayName) + '. Dane lokalne mogą należeć do poprzedniego konta. Kontynuować?')) { disconnect(); return; }
      }
      initializeAccount(user);
      notice = 'Połączono. Kliknij „Synchronizuj”, aby sprawdzić wszystkie dane.';
    } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
    finally { authorizing = false; render(); }
    if (connected() && continuation) await synchronize();
  }
  async function prepareRuntime() {
    if (!configured) { render(); return; }
    try {
      if (!root.isSecureContext || !root.crypto.subtle) throw new Error('Synchronizacja wymaga HTTPS lub localhost.');
      if (!root.navigator.locks) throw new Error('Ta przeglądarka nie obsługuje bezpiecznej synchronizacji wielu kart. Użyj aktualnej przeglądarki.');
      if (!root.localforage) throw new Error('Nie załadowano pamięci danych. Odśwież stronę.');
      if (panel) {
      await loadGIS();
      client = root.google.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope: SCOPE,
        include_granted_scopes: false, callback: receiveToken,
        error_callback: () => { authorizing = false; afterAuth = null; notice = 'Okno Google zostało zamknięte lub zablokowane. Kliknij przycisk połączenia ponownie.'; render(); }
      });
      ready = true;
      }
      let saved; try { saved = JSON.parse(root.sessionStorage.getItem(SESSION_KEY)); } catch (_) { }
      if ((!saved || !saved.token || saved.token.expiresAt <= Date.now()) && prefs.connectionActive && prefs.boundAccount) saved = await requestPeerSession();
      if (saved && saved.clientId === config.clientId && object(saved.token) && typeof saved.token.accessToken === 'string' &&
          Number.isFinite(saved.token.expiresAt) && saved.token.expiresAt > Date.now() && saved.accountId === prefs.boundAccount && prefs.connectionActive) {
        authorizing = true; notice = 'Przywracanie połączenia z Google Drive…'; render(); token = saved.token;
        try {
          const user = await identifyAccount();
          if (user.permissionId !== saved.accountId) throw new Error('Konto Google zmieniło się. Połącz ponownie.');
          initializeAccount(user); notice = 'Połączenie zachowane. Kliknij „Synchronizuj”, aby sprawdzić dane.';
        } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
        finally { authorizing = false; }
      } else clearSession();
      render();
    } catch (e) { notice = e.message; render(); }
  }
  function prepare() { if (!preparePromise) preparePromise = prepareRuntime(); return preparePromise; }
  function requestPeerSession() {
    if (!connectionChannel) return Promise.resolve(null);
    return new Promise(resolve => {
      const nonce = tabId + '-' + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { sessionRequest = null; resolve(null); }, 500);
      sessionRequest = { nonce, accept: value => { clearTimeout(timer); sessionRequest = null; resolve(value); } };
      connectionChannel.postMessage({ type: 'session-request', nonce, accountId: prefs.boundAccount, clientId: config.clientId });
    });
  }
  function renewEditLease() {
    if (!pageEdited || !prefs.connectionActive || !prefs.boundAccount) return;
    try { root.localStorage.setItem(EDIT_PREFIX + tabId, JSON.stringify({ account: prefs.boundAccount, expiresAt: Date.now() + 120000 })); } catch (_) { }
  }
  function otherPageEditing() {
    for (let i = 0; i < root.localStorage.length; i++) {
      const key = root.localStorage.key(i);
      if (!key.startsWith(EDIT_PREFIX) || key === EDIT_PREFIX + tabId) continue;
      try { const lease = JSON.parse(root.localStorage.getItem(key)); if (lease.account === prefs.boundAccount && lease.expiresAt > Date.now()) return true; } catch (_) { }
    }
    return false;
  }
  function markEditing(event) {
    const target = event.target;
    if (!target || !target.closest || target.closest('#infomatyka-drive-settings, #infomatyka-drive-refresh, #infomatyka-drive-indicator')) return;
    if (event.type === 'pointerdown' && !target.closest('button, canvas, [contenteditable="true"], input, textarea, select')) return;
    pageEdited = true; renewEditLease();
  }
  function checkEpoch(category) {
    return root.localStorage.getItem(HYDRATION_PREFIX + category) === loadedEpochs[category];
  }
  function guardWrite(category) {
    if (!category || internalWrites.has(category) || checkEpoch(category)) return;
    needsReload = true; renderConnectionStatus();
    const error = new Error('Dane zostały wczytane z Google Drive w innej karcie. Odśwież tę stronę przed dalszym zapisem.'); error.code = 'DRIVE_RELOAD_REQUIRED'; throw error;
  }
  function guardBoardWrite() {
    if (!needsReload) return;
    const error = new Error('Biblioteka zmieniła się w innej karcie. Odśwież stronę przed zapisaniem tablicy.'); error.code = 'DRIVE_RELOAD_REQUIRED'; throw error;
  }
  function localChanged(category) {
    if (!category || internalWrites.has(category)) return;
    recordLocalChange(category);
    if (connectionChannel) connectionChannel.postMessage({ type: 'local-change', accountId: prefs.boundAccount });
  }
  function installObservers() {
    const proto = root.Storage && root.Storage.prototype;
    if (proto) {
      const set = proto.setItem, remove = proto.removeItem, clear = proto.clear;
      proto.setItem = function (key, value) {
        const category = this === root.localStorage ? keyCategory.get(String(key)) : null;
        const changed = category && this.getItem(key) !== String(value);
        if (changed) guardWrite(category);
        const result = set.call(this, key, value); if (changed) localChanged(category); return result;
      };
      proto.removeItem = function (key) {
        const category = this === root.localStorage ? keyCategory.get(String(key)) : null, changed = category && this.getItem(key) !== null;
        if (changed) guardWrite(category);
        const result = remove.call(this, key); if (changed) localChanged(category); return result;
      };
      proto.clear = function () {
        if (this === root.localStorage) Object.keys(CATEGORIES).forEach(guardWrite);
        const result = clear.call(this); if (this === root.localStorage) localChanged('profile'); return result;
      };
    }
    if (root.localforage) ['setItem', 'removeItem'].forEach(method => {
      const original = root.localforage[method]; if (typeof original !== 'function') return;
      root.localforage[method] = function (key, ...args) {
        const tracked = key === 'infomatyka-generator-task-cache' && !internalWrites.has('generator');
        if (tracked) guardWrite('generator');
        const result = original.call(this, key, ...args);
        if (tracked && result && result.then) result.then(() => localChanged('generator'), () => {});
        return result;
      };
    });
    ['beforeinput', 'change', 'pointerdown'].forEach(event => document.addEventListener(event, markEditing, true));
    root.addEventListener('infomatyka-boards-changed', () => localChanged('boards'));
    root.addEventListener('infomatyka_progress_updated', () => localChanged('progress'));
    root.addEventListener('offline', render);
    root.addEventListener('online', render);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { renewEditLease(); if (needsReload && !pageEdited) scheduleRefresh(); }
    });
    root.addEventListener('pagehide', () => {
      clearTimeout(refreshTimer);
      try { root.localStorage.removeItem(EDIT_PREFIX + tabId); } catch (_) { }
    });
    try {
      if (root.BroadcastChannel) {
        connectionChannel = new root.BroadcastChannel('infomatyka_boards');
        connectionChannel.onmessage = event => {
          const message = event.data;
          if (message === 'changed') return;
          if (!object(message)) return;
          if (message.type === 'session-request' && connected() && prefs.connectionActive && message.accountId === account.permissionId && message.clientId === config.clientId) {
            connectionChannel.postMessage({ type: 'session-response', nonce: message.nonce, token, accountId: account.permissionId, clientId: config.clientId });
          } else if (message.type === 'session-response' && sessionRequest && message.nonce === sessionRequest.nonce && message.accountId === prefs.boundAccount && message.clientId === config.clientId) {
            sessionRequest.accept(message);
          }
        };
      }
    } catch (_) { }
  }
  function scheduleRefresh() {
    if (panel || pageEdited || !needsReload || document.visibilityState !== 'visible') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const inProgress = Object.keys(CATEGORIES).some(category => {
        try { const epoch = JSON.parse(root.localStorage.getItem(HYDRATION_PREFIX + category)); return epoch && !epoch.done && Date.now() - epoch.at < 30000; } catch (_) { return false; }
      });
      if (inProgress || busy) { scheduleRefresh(); return; }
      if (!pageEdited && needsReload) root.location.reload();
    }, 250);
  }
  function driveStatus(message, state = 'warning') { return { message, state }; }
  function connectionStatus() {
    if (needsReload) return driveStatus('Drive: odśwież widok po pobraniu danych');
    if (!prefs.connectionActive) return null;
    if (notice && !ready && !connected()) return driveStatus('Drive: ' + notice, authorizing ? 'syncing' : 'error');
    if (root.navigator.onLine === false) return driveStatus('Drive: offline — dane pozostają lokalnie', 'offline');
    if (!connected()) return prefs.accountEmail ? driveStatus('Połączenie z Google Drive wygasło. Połącz ponownie.', 'warning') : null;
    return driveStatus('Drive połączony · synchronizacja ręczna', 'info');
  }
  function renderConnectionStatus() {
    if (!root.InfoMatykaDriveIndicator) return;
    const status = connectionStatus();
    if (!status || panel) root.InfoMatykaDriveIndicator.hide();
    else root.InfoMatykaDriveIndicator.show(status);
  }
  function beginConnect(changeAccount = false, continuation = null) {
    if (!ready || busy || authorizing) return;
    token = null; account = null; engine = null; clearSession(); comparisons = []; recovery = []; operationErrors = []; pendingDirection = null;
    afterAuth = continuation; authorizing = true; notice = 'Łączenie z Google Drive…'; render();
    try {
      client.requestAccessToken({ prompt: changeAccount || !prefs.accountEmail ? 'select_account' : '',
        ...(changeAccount || !prefs.accountEmail ? {} : { login_hint: prefs.accountEmail }) });
    } catch (e) { authorizing = false; afterAuth = null; notice = e.message; render(); }
  }
  const differs = review => !review.error && !['same', 'none'].includes(review.action);
  async function inspectAll(verifyBoardAssets = false) {
    const results = await Promise.allSettled(SYNC_CATEGORIES.map(category => engine.inspect(category, { verifyBoardAssets })));
    const reviews = results.map((result, index) => result.status === 'fulfilled' ? result.value : { category: SYNC_CATEGORIES[index], error: result.reason.message });
    recordInspectionState(reviews);
    return reviews;
  }
  async function backupBeforeGlobalAction(reviews) {
    const prepared = [];
    for (const review of reviews) {
      const remoteData = review.remoteData || (review.cloud[0] && review.cloud[0].data);
      const remoteBackup = remoteData ? await engine.prepareBoardAssets(remoteData, null, review.local.boardAssetBlobs || []) : null;
      prepared.push({ review, remoteBackup });
    }
    for (const { review, remoteBackup } of prepared) {
      await engine.backup(review.category, review.local, 'Lokalnie przed synchronizacją wszystkich danych');
      if (remoteBackup) await engine.backup(review.category, remoteBackup, 'Google Drive przed synchronizacją wszystkich danych');
    }
  }
  async function synchronize(source = null) {
    if (busy || authorizing) return;
    if (!connected() || !engine) { beginConnect(false, { synchronize: true }); return; }
    busy = true; progressMessage = ''; notice = source ? 'Zastosowywanie wybranego działania…' : 'Porównywanie danych lokalnych i Google Drive…'; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
        if (latest.boundAccount !== account.permissionId) throw new Error('Konto zmieniło się w innej karcie. Sprawdź synchronizację ponownie.');
        const fresh = await inspectAll(true);
        if (source) {
          const previousReviews = new Map(comparisons.map(review => [review.category, review]));
          const staleReviews = fresh.some(review => {
            const previous = previousReviews.get(review.category);
            return review.error || !previous || previous.localHash !== review.localHash || previous.signature !== review.signature;
          });
          if (staleReviews) {
            comparisons = fresh; operationErrors = [];
            notice = 'Dane zmieniły się od czasu porównania. Sprawdź je ponownie i wybierz działanie jeszcze raz.'; return;
          }
          if (fresh.some(review => review.duplicateDevices.length)) {
            comparisons = fresh; operationErrors = fresh.filter(review => review.duplicateDevices.length)
              .map(review => CATEGORIES[review.category].label + ': kilka zapisów dla tego samego urządzenia.');
            notice = 'Wykryto niejednoznaczne kopie na Google Drive. Operacja została wstrzymana, aby chronić dane. Szczegóły są niżej.'; return;
          }
          if (source === 'merge' && fresh.some(review => review.baseCorrupt || !review.mergePreview && review.cloud.length)) {
            comparisons = fresh; operationErrors = fresh.filter(review => review.baseCorrupt || !review.mergePreview && review.cloud.length)
              .map(review => CATEGORIES[review.category].label + ': brakuje poprawnej wspólnej bazy do bezpiecznego łączenia.');
            notice = 'Nie można bezpiecznie połączyć wszystkich danych. Wybierz jedną całą wersję; obie strony zostaną wcześniej skopiowane.'; return;
          }
          const changes = fresh.filter(differs);
          if (!changes.length) {
            comparisons = fresh; operationErrors = [];
            notice = 'Wszystkie dane są już zgodne.'; return;
          }
          const failures = [];
          operationErrors = [];
          await backupBeforeGlobalAction(changes);
          for (const review of changes) {
            try {
              const result = await engine.sync(review.category, {
                signature: review.signature, localHash: review.localHash,
                source,
                skipBackup: true,
              });
              if (result.action === 'conflict') throw new Error('Dane zmieniły się podczas operacji.');
              if (!['same', 'none'].includes(result.action)) recordSuccessfulSync(review, result, review.cloud[0] || null);
            } catch (error) {
              root.console?.error('[InfoMatyka Drive] Błąd synchronizacji kategorii „' + review.category + '”', error);
              failures.push(CATEGORIES[review.category].label + ': ' + error.message);
            }
          }
          comparisons = await inspectAll();
          const verificationErrors = comparisons.filter(review => review.error)
            .map(review => CATEGORIES[review.category].label + ': ponowne sprawdzenie nie powiodło się: ' + review.error);
          operationErrors = failures;
          notice = failures.length ? 'Nie udało się zakończyć wszystkich zmian. Ukończono ' + (changes.length - failures.length) + ' z ' + changes.length + '. Szczegóły są niżej.' :
            verificationErrors.length ? 'Zmiany zostały zastosowane, ale nie udało się ponownie sprawdzić wszystkich danych. Szczegóły są niżej.' :
            source === 'local' ? 'Dane z tego urządzenia wysłano do Google Drive. Kopie obu wersji zapisano lokalnie.' :
            source === 'cloud' ? 'Pobrano dane z Google Drive. Poprzednie wersje zapisano lokalnie.' :
            'Połączono zmiany. Przy konflikcie tego samego pola wybrano wersję z Drive; kopie obu wersji zapisano lokalnie.';
        } else {
          comparisons = fresh; operationErrors = fresh.filter(review => review.error)
            .map(review => CATEGORIES[review.category].label + ': ' + review.error);
          const conflictCount = comparisons.reduce((sum, review) => sum + (review.mergePreview?.conflicts.length || 0), 0);
          notice = operationErrors.length ? 'Nie udało się porównać wszystkich danych. Szczegóły są niżej.' : comparisons.some(differs) ?
            'Wykryto różnice w ' + comparisons.filter(differs).length + ' z ' + SYNC_CATEGORIES.length + ' obszarów. Wybierz, jak potraktować całość.' :
            comparisons.every(review => review.localVersion.empty && !review.cloud.length) ? 'Brak danych do synchronizacji. Możesz zacząć na tym urządzeniu.' :
              'Wszystkie dane są zgodne. Google Drive i to urządzenie mają tę samą wersję.';
          if (conflictCount) notice += ' Automatyczne łączenie rozwiąże ' + conflictCount + ' nakładających się zmian na korzyść Drive.';
        }
      });
    } catch (e) { notice = e.message; }
    finally { busy = false; progressMessage = ''; render(); }
  }
  async function makeRecoveryArchive(items) {
    const binaryParts = []; let offset = 0;
    const archiveItems = items.map(({ key, copies }) => ({ key, copies: copies.map(copy => {
      const archivedCopy = { ...copy, data: { ...copy.data } };
      const blobs = copy.data && copy.data.boardAssetBlobs;
      if (blobs) archivedCopy.data.boardAssetBlobs = blobs.map(asset => {
        if (!(asset.blob instanceof Blob)) throw new Error('Lokalna kopia tablicy nie zawiera kompletnego pliku binarnego.');
        const descriptor = { id: asset.id, offset, size: asset.blob.size, mime: asset.blob.type };
        binaryParts.push(asset.blob); offset += asset.blob.size;
        return descriptor;
      });
      return archivedCopy;
    }) }));
    const header = new TextEncoder().encode(JSON.stringify({ app: 'InfoMatyka', recoverySchema: 2, archiveSchema: 1, items: archiveItems }));
    if (header.length > RECOVERY_HEADER_LIMIT) throw new Error('Opis kopii jest zbyt duży, aby pobrać go w jednym archiwum.');
    const headerLength = new Uint8Array(4); new DataView(headerLength.buffer).setUint32(0, header.length);
    return new Blob([RECOVERY_MAGIC, headerLength, header, ...binaryParts], { type: 'application/vnd.infomatyka.drive-recovery' });
  }
  async function readRecoveryArchive(file) {
    const prefixLength = RECOVERY_MAGIC.length + 4;
    if (!file || file.size < prefixLength || await file.slice(0, RECOVERY_MAGIC.length).text() !== RECOVERY_MAGIC) {
      throw new Error('Wybrany plik nie jest archiwum kopii InfoMatyki.');
    }
    const lengthBytes = new Uint8Array(await file.slice(RECOVERY_MAGIC.length, prefixLength).arrayBuffer());
    const headerLength = new DataView(lengthBytes.buffer).getUint32(0);
    if (!headerLength || headerLength > RECOVERY_HEADER_LIMIT || prefixLength + headerLength > file.size) throw new Error('Nagłówek archiwum kopii jest nieprawidłowy.');
    let header;
    try { header = JSON.parse(await file.slice(prefixLength, prefixLength + headerLength).text()); }
    catch (_) { throw new Error('Nie udało się odczytać spisu kopii w archiwum.'); }
    if (!object(header) || header.app !== 'InfoMatyka' || header.recoverySchema !== 2 || header.archiveSchema !== 1 || !Array.isArray(header.items)) {
      throw new Error('Wersja archiwum kopii nie jest obsługiwana.');
    }
    const payloadOffset = prefixLength + headerLength, payloadSize = file.size - payloadOffset, seenKeys = new Set();
    const items = [];
    for (const item of header.items) {
      if (!object(item) || typeof item.key !== 'string' || !Array.isArray(item.copies) || seenKeys.has(item.key)) throw new Error('Archiwum zawiera nieprawidłowy spis kopii.');
      seenKeys.add(item.key);
      const separator = item.key.lastIndexOf(':'), category = item.key.slice(separator + 1);
      if (separator < 1 || !has(CATEGORIES, category)) throw new Error('Archiwum zawiera nieznaną kategorię danych.');
      const copies = item.copies.map(copy => {
        if (!object(copy) || copy.category !== category || !object(copy.data)) throw new Error('Archiwum zawiera nieprawidłową kopię.');
        const data = { ...copy.data };
        if (has(data, 'boardAssetBlobs')) {
          if (!object(data.boards) || !Array.isArray(data.boards.assets) || !Array.isArray(data.boardAssetBlobs)) throw new Error('Kopia tablic w archiwum jest niekompletna.');
          const assets = new Map(data.boards.assets.map(asset => [asset.id, asset])), used = new Set();
          data.boardAssetBlobs = data.boardAssetBlobs.map(descriptor => {
            if (!object(descriptor) || !assets.has(descriptor.id) || used.has(descriptor.id) ||
                !Number.isSafeInteger(descriptor.offset) || descriptor.offset < 0 || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 ||
                descriptor.offset + descriptor.size > payloadSize || descriptor.size > MAX_ASSET_BYTES) throw new Error('Dane obrazu lub dokumentu w archiwum są nieprawidłowe.');
            const asset = assets.get(descriptor.id);
            if (descriptor.size !== asset.size || descriptor.mime !== asset.mime) throw new Error('Opis pliku w archiwum nie zgadza się z manifestem tablic.');
            used.add(descriptor.id);
            return { id: descriptor.id, blob: file.slice(payloadOffset + descriptor.offset, payloadOffset + descriptor.offset + descriptor.size, descriptor.mime) };
          });
          if (used.size !== assets.size) throw new Error('W archiwum brakuje pliku wymaganego przez kopię tablic.');
        }
        return { ...copy, data };
      });
      items.push({ key: item.key, copies });
    }
    return items;
  }
  async function downloadRecovery() {
    try {
      const items = [];
      const store = getBackupStore(); if (!store) throw new Error('Nie załadowano lokalnego magazynu kopii.');
      await store.iterate((copies, key) => { items.push({ key, copies }); });
      const archive = await makeRecoveryArchive(items);
      const url = URL.createObjectURL(archive);
      const a = document.createElement('a'); a.href = url; a.download = 'infomatyka-kopie-przed-synchronizacja.imbackup'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { notice = e.message; render(); }
  }
  async function showRecovery() {
    try {
      recovery = [];
      const recoveryAccount = account && account.permissionId || recoveryAccountSelection || prefs.boundAccount;
      const store = getBackupStore(); if (!store) throw new Error('Nie załadowano lokalnego magazynu kopii.');
      if (!recoveryAccount) { notice = 'Połącz konto Google albo zaimportuj archiwum, aby wyświetlić jego kopie.'; render(); return; }
      for (const category of Object.keys(CATEGORIES)) {
        recovery.push(...(await store.getItem(recoveryAccount + ':' + category) || []).map(copy => ({ ...copy, recoveryAccount })));
      }
      notice = recovery.length ? 'Wybierz kopię do przywrócenia na tym urządzeniu.' : 'Nie ma jeszcze kopii sprzed synchronizacji dla tego konta.';
    } catch (e) { notice = e.message; }
    render();
  }
  async function importRecovery(file) {
    if (!file || busy) return;
    busy = true; notice = 'Sprawdzanie archiwum kopii…'; render();
    try {
      const items = await readRecoveryArchive(file), store = getBackupStore();
      if (!store) throw new Error('Nie załadowano lokalnego magazynu kopii.');
      for (const item of items) for (const copy of item.copies) if (copy.category === 'boards') {
        validateBoards(copy.data.boards);
        const blobs = new Map((copy.data.boardAssetBlobs || []).map(asset => [asset.id, asset.blob]));
        for (const asset of copy.data.boards.assets) if (!await validateAssetBlob(asset, blobs.get(asset.id), root.crypto)) {
          throw new Error('Archiwum zawiera niekompletną lub uszkodzoną kopię tablic. Żadna kopia nie została zaimportowana.');
        }
      }
      const previous = [];
      try {
        for (const item of items) {
          const existing = await store.getItem(item.key) || [];
          previous.push({ key: item.key, value: existing });
          await store.setItem(item.key, [...item.copies, ...existing].slice(0, 5));
        }
      } catch (error) {
        for (const entry of previous.reverse()) {
          try { if (entry.value.length) await store.setItem(entry.key, entry.value); else await store.removeItem(entry.key); } catch (_) { }
        }
        throw error;
      }
      if (items.length) recoveryAccountSelection = items[0].key.slice(0, items[0].key.lastIndexOf(':'));
      await showRecovery();
      notice = 'Zaimportowano lokalne kopie. Wybierz kopię z listy, aby ją przywrócić.';
    } catch (e) { notice = e.message; }
    finally { busy = false; render(); }
  }
  function createRecoveryEngine(accountId) {
    const store = getBackupStore();
    const device = root.localStorage.getItem(DEVICE_KEY) || root.crypto.randomUUID();
    return new SyncEngine({ storage: root.localStorage, bases: getBaseStore(), backups: store,
      boards: new BoardStore(root.indexedDB, root.crypto, notifyBoardsChanged), crypto: root.crypto, transport,
      device, deviceName: prefs.deviceName || '', account: accountId, beforeApply: category => {
        if (category === 'boards' && (pageEdited || otherPageEditing())) throw new Error('Zamknij lub zapisz edycję tablic na innych kartach przed przywróceniem kopii.');
      },
      onApplyStart: category => {
        internalWrites.add(category); previousEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category);
        const epoch = JSON.stringify({ tab: tabId, at: Date.now(), account: accountId, done: false });
        loadedEpochs[category] = epoch; root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
      },
      onApplyEnd: (category, succeeded) => {
        if (!succeeded) {
          const epoch = previousEpochs[category];
          if (epoch === null) root.localStorage.removeItem(HYDRATION_PREFIX + category); else root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
          loadedEpochs[category] = epoch;
        } else {
          const epoch = JSON.stringify({ tab: tabId, at: Date.now(), account: accountId, done: true });
          loadedEpochs[category] = epoch; root.localStorage.setItem(HYDRATION_PREFIX + category, epoch);
        }
        internalWrites.delete(category);
      },
      onApplied: category => {
        applied = true; if (category === 'progress') root.dispatchEvent(new Event('infomatyka_progress_updated'));
        root.dispatchEvent(new CustomEvent('infomatyka_drive_applied', { detail: { category } }));
      }
    });
  }
  async function restoreCopy(copy) {
    if (busy || !CATEGORIES[copy.category] || !root.confirm('Przywrócić lokalnie dane „' + CATEGORIES[copy.category].label + '” z ' + formatDate(copy.at) + '?')) return;
    const recoveryAccount = copy.recoveryAccount || account && account.permissionId || recoveryAccountSelection || prefs.boundAccount;
    if (!recoveryAccount || (copy.recoveryAccount && copy.recoveryAccount !== recoveryAccount)) { notice = 'Ta kopia należy do innego konta. Połącz właściwe konto albo otwórz jego archiwum.'; render(); return; }
    busy = true; render();
    try {
      if (copy.category === 'boards') {
        validateBoards(copy.data.boards);
        const blobs = new Map((copy.data.boardAssetBlobs || []).map(item => [item.id, item.blob]));
        for (const asset of copy.data.boards.assets) if (!await validateAssetBlob(asset, blobs.get(asset.id), root.crypto)) {
          throw new Error('Nie udało się odczytać kompletnej kopii tablic. Bieżące dane nie zostały zmienione.');
        }
      }
      const recoveryEngine = createRecoveryEngine(recoveryAccount);
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        await recoveryEngine.apply(copy.category, copy.data, await recoveryEngine.capture(copy.category), 'Lokalnie przed przywróceniem kopii');
      });
      recovery = []; comparisons = []; pendingDirection = null; notice = 'Przywrócono lokalną kopię. Google Drive nie został zmieniony. Sprawdź synchronizację przed kolejną zmianą.';
    } catch (e) { notice = e.message; }
    finally { busy = false; render(); }
  }
  function button(label, action, disabled = false, className = '') {
    const b = text('button', label, 'im-drive-button ' + className); b.type = 'button'; b.disabled = disabled || busy || authorizing; b.addEventListener('click', action); return b;
  }
  function formatBytes(bytes) {
    return bytes < 1024 ? bytes + ' B' : (bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString('pl-PL', { maximumFractionDigits: 2 }) + (bytes < 1024 * 1024 ? ' KiB' : ' MiB');
  }
  function formatDate(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pl-PL') : 'Data zapisu nieznana'; }
  function confirmGlobalAction(source) {
    pendingDirection = { source };
    render();
  }
  function renderGlobalConfirmation() {
    if (!pendingDirection) return null;
    const { source } = pendingDirection;
    const box = text('section', '', 'im-drive-confirmation');
    box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-live', 'assertive');
    const messages = {
      cloud: 'Dane zapisane w Google Drive zastąpią na tym urządzeniu wszystkie zsynchronizowane dane. Zbiory nieobecne w Drive zostaną wyczyszczone. Przed zmianą lokalna i chmurowa wersja zostaną skopiowane na to urządzenie.',
      local: 'Dane z tego urządzenia zastąpią zsynchronizowane dane na Google Drive. Przed zmianą lokalna i chmurowa wersja zostaną skopiowane na to urządzenie.',
      merge: 'Niezależne zmiany lokalne i z Google Drive zostaną połączone. Jeśli to samo pole zmieniono inaczej, pozostanie wartość z Drive. Przed zmianą obie wersje zostaną skopiowane na to urządzenie.'
    };
    box.append(text('p', messages[source]));
    const actions = text('div', '', 'im-drive-actions');
    actions.append(button('Potwierdź', () => {
      pendingDirection = null;
      synchronize(source);
    }), button('Anuluj', () => { pendingDirection = null; render(); }, false, 'im-drive-secondary'));
    box.append(actions);
    return box;
  }
  function renderComparison() {
    const box = text('section', '', 'im-drive-comparison');
    box.append(text('h4', 'Stan synchronizacji'));
    const valid = comparisons.filter(review => !review.error);
    const different = valid.filter(differs);
    const hasComparisonErrors = comparisons.some(review => review.error);
    const localBytes = valid.reduce((sum, review) => sum + review.localVersion.bytes, 0);
    const cloudBytes = valid.reduce((sum, review) => sum + review.cloud.reduce((total, record) => total + (record.fileBytes || record.bytes), 0), 0);
    const versions = text('div', '', 'im-drive-versions');
    const localCard = text('div', '', 'im-drive-version');
    localCard.append(text('h5', 'Na tym urządzeniu'), text('p', valid.every(review => review.localVersion.empty) ? 'Brak zapisanych danych.' : formatBytes(localBytes)));
    const cloudCard = text('div', '', 'im-drive-version');
    cloudCard.append(text('h5', 'Google Drive'), text('p', valid.some(review => review.cloud.length) ? formatBytes(cloudBytes) : 'Brak zapisanej kopii.'));
    versions.append(localCard, cloudCard);
    box.append(versions);

    box.append(text('p', hasComparisonErrors ? 'Nie wszystkie dane udało się porównać. Operacja jest wstrzymana.' : different.length ?
      'Różnice dotyczą ' + different.length + ' z ' + valid.length + ' obszarów. Decyzja obejmie wszystkie zsynchronizowane dane.' :
      comparisons.every(review => review.localVersion && review.localVersion.empty && !review.cloud.length) ?
        'Brak danych do synchronizacji. Możesz zacząć na tym urządzeniu.' : 'Google Drive i to urządzenie mają tę samą wersję.', 'im-drive-help'));

    const hasDuplicates = different.some(review => review.duplicateDevices.length);
    if (different.length && !hasComparisonErrors && !pendingDirection) {
      const canMerge = different.every(review => !review.baseCorrupt && (review.mergePreview || !review.cloud.length && review.action === 'push'));
      const actions = text('div', '', 'im-drive-actions im-drive-global-actions');
      actions.append(button('Użyj Google Drive', () => confirmGlobalAction('cloud'), hasDuplicates));
      actions.append(button('Użyj danych z tego urządzenia', () => confirmGlobalAction('local'), hasDuplicates, 'im-drive-secondary'));
      actions.append(button('Połącz zmiany', () => confirmGlobalAction('merge'), hasDuplicates || !canMerge, 'im-drive-secondary'));
      box.append(actions);
      box.append(text('p', hasDuplicates ? 'Znaleziono kilka plików przypisanych do tego samego urządzenia. Wybór został wstrzymany, aby nie zgubić kopii.' :
        'Połączenie scala niezależne zmiany. Przy zmianie tego samego pola pozostaje wartość z Google Drive. Przed decyzją zapisywane są lokalne kopie obu wersji.', 'im-drive-help'));
    }

    const details = text('details', '', 'im-drive-details');
    details.append(text('summary', 'Szczegóły'));
    operationErrors.forEach(error => details.append(text('p', error, 'im-drive-status')));
    comparisons.filter(review => review.error).forEach(review => details.append(text('p', CATEGORIES[review.category].label + ': ' + review.error, 'im-drive-status')));
    comparisons.filter(review => review.baseCorrupt).forEach(review => details.append(text('p', CATEGORIES[review.category].label + ': nie można odczytać wspólnej bazy synchronizacji.', 'im-drive-status')));
    if (hasDuplicates) details.append(text('p', 'Google Drive zawiera kilka plików dla tego samego urządzenia. Operacja jest wstrzymana, aby zachować wszystkie kopie.', 'im-drive-status'));
    if (different.length && !hasComparisonErrors) {
      const conflictCount = different.reduce((sum, review) => sum + (review.mergePreview ? review.mergePreview.conflicts.length : 0), 0);
      details.append(text('p', 'Różnice: ' + different.length + ' obszarów · nakładające się zmiany: ' + conflictCount + '.'));
    }
    details.open = hasComparisonErrors || operationErrors.length > 0 || comparisons.some(review => review.baseCorrupt) || hasDuplicates;
    box.append(details);
    if (pendingDirection) box.append(renderGlobalConfirmation());
    return box;
  }
  function render() {
    renderConnectionStatus();
    if (!panel) return;
    panel.replaceChildren();
    panel.append(text('h3', 'Cloud Save'));
    panel.append(text('p', 'Zapisuj trwałe dane InfoMatyki na Google Drive i przenoś je na inne urządzenie. Aplikacja ma dostęp tylko do swojego prywatnego folderu.'));

    const top = text('div', '', 'im-drive-toolbar');
    const accountLabel = connected() ? 'Połączono: ' + (account.emailAddress || account.displayName) :
      prefs.accountEmail ? 'Konto: ' + prefs.accountEmail + ' · połącz ponownie' : 'Połącz konto Google, aby rozpocząć.';
    top.append(text('span', accountLabel, 'im-drive-status'));
    top.append(button(connected() ? 'Zmień konto' : 'Połącz Google Drive',
      () => beginConnect(connected(), connected() ? null : { synchronize: true }), !ready, 'im-drive-secondary'));
    if (connected()) top.append(button('Odłącz', disconnect, false, 'im-drive-secondary'));
    panel.append(top);

    if (connected()) {
      panel.append(text('p', 'Synchronizacja obejmuje wszystkie trwałe dane InfoMatyki. Sprawdzenie niczego nie zmienia; decyzja o pobraniu, wysłaniu lub połączeniu zawsze należy do Ciebie.', 'im-drive-help'));
      panel.append(button(busy ? (progressMessage || 'Synchronizowanie…') : 'Synchronizuj', () => synchronize()));
    } else if (!configured) {
      panel.append(text('p', 'Administrator nie skonfigurował jeszcze połączenia Google Drive.', 'im-drive-help'));
    }

    const status = text('p', progressMessage || notice, 'im-drive-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.append(status);
    if (comparisons.length && connected()) panel.append(renderComparison());
    if (applied) panel.append(button('Odśwież widok po wczytaniu danych', () => root.location.reload()));

    const history = text('details', '', 'im-drive-details');
    history.append(text('summary', 'Historia danych i kopie zapasowe'));
    history.append(text('p', 'Przed wysłaniem, pobraniem, połączeniem lub przywróceniem tworzone są lokalne kopie. Obejmują także pliki tablic.', 'im-drive-help'));
    const historyActions = text('div', '', 'im-drive-actions');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.imbackup,application/vnd.infomatyka.drive-recovery';
    importInput.hidden = true;
    importInput.addEventListener('change', () => {
      if (importInput.files && importInput.files[0]) importRecovery(importInput.files[0]);
      importInput.value = '';
    });
    historyActions.append(importInput,
      button('Historia danych', showRecovery, !root.localforage, 'im-drive-secondary'),
      button('Pobierz kopię', downloadRecovery, !root.localforage, 'im-drive-secondary'),
      button('Wczytaj kopię', () => importInput.click(), !root.localforage, 'im-drive-secondary'));
    history.append(historyActions);
    recovery.forEach(copy => history.append(button('Przywróć: ' + CATEGORIES[copy.category].label + ' · ' + formatDate(copy.at) + ' · ' +
      (copy.reason || 'kopia lokalna') + ' · ' + formatBytes(byteSize(copy.data)), () => restoreCopy(copy), false, 'im-drive-secondary')));
    panel.append(history);
    if (recovery.length) history.open = true;
  }
  async function getDiagnostics() {
    const reviews = new Map();
    if (engine && connected()) {
      await Promise.all(Object.keys(CATEGORIES).map(async category => {
        try { reviews.set(category, await engine.inspect(category)); } catch (_) { }
      }));
    }
    const countEntities = value => Array.isArray(value) ? value.length : object(value) ? Object.values(value).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0) : 0;
    const hashValue = async value => value === undefined ? null : digest(value, root.crypto, false);
    return DATA_REGISTRY.getDiagnostics().map(async datasetInfo => {
      const dataset = DATA_REGISTRY.get(datasetInfo.datasetId);
      const review = dataset.category ? reviews.get(dataset.category) : null;
      const local = dataset.key && review ? review.local.local[dataset.key] : dataset.id === 'boards.library' && review ? review.local.boards : undefined;
      const base = dataset.key && review && review.base ? review.base.data.local[dataset.key] : dataset.id === 'boards.library' && review && review.base ? review.base.data.boards : undefined;
      const remote = dataset.key && review && review.remoteData ? review.remoteData.local[dataset.key] : dataset.id === 'boards.library' && review && review.remoteData ? review.remoteData.boards : undefined;
      return { ...datasetInfo, localHash: await hashValue(local), baseHash: await hashValue(base), remoteHash: await hashValue(remote),
        localDirty: review ? stable(local) !== stable(base) : null, remoteChanged: review ? stable(remote) !== stable(base) : null,
        entityCount: countEntities(local), conflictCount: review ? (review.mergePreview?.conflicts || []).filter(conflict => conflict.dataset === dataset.id).length : null,
        lastSync: review ? categoryState(dataset.category).lastSuccessfulSyncAt : null };
    }).reduce(async (previous, current) => [...await previous, await current], Promise.resolve([]));
  }
  root.InfoMatykaDrive = { version: MODULE_VERSION, categories: CATEGORIES, synchronize: () => synchronize(), disconnect,
    getDiagnostics, isConnected: connected, guardBoardWrite,
    isBusy: () => busy || authorizing,
    mount: async function (element) { panel = element; if (!client) preparePromise = null; render(); await prepare(); } };
  root.addEventListener('storage', event => {
    if (event.key === SETTINGS_KEY || event.key === null) {
      try {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY));
        if (!latest || latest.connectionActive === false || (account && latest.boundAccount !== account.permissionId)) { disconnect(false); return; }
        mergeSavedPrefs(latest);
        comparisons = []; recovery = []; operationErrors = []; pendingDirection = null; render();
      } catch (_) { disconnect(false); }
    } else if (event.key && event.key.startsWith(HYDRATION_PREFIX)) {
      const category = event.key.slice(HYDRATION_PREFIX.length);
      if (has(CATEGORIES, category) && !checkEpoch(category)) { needsReload = true; renderConnectionStatus(); scheduleRefresh(); }
    } else if (keyCategory.has(event.key)) localChanged(keyCategory.get(event.key));
  });
  setInterval(() => {
    renewEditLease();
    if (token && !connected()) {
      token = null; account = null; engine = null; comparisons = []; pendingDirection = null; clearSession();
      notice = 'Połączenie z Google Drive wygasło. Połącz ponownie.'; render();
    }
    if (needsReload) scheduleRefresh();
  }, 30000);
  function startRuntime() { panel = document.getElementById('infomatyka-drive-settings'); installObservers(); render(); prepare(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startRuntime); else startRuntime();
})(typeof window !== 'undefined' ? window : globalThis);
