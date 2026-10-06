/* InfoMatyka: private, browser-only Google Drive synchronization (schema 3).
 * OAuth access survives navigation in tab-scoped sessionStorage until Google expiry.
 * Each device writes its own head; no client secrets or refresh tokens are used.
 * Vector clocks detect simultaneous changes; conflicts require a user decision.
 */
(function (root) {
  'use strict';
  if (root.InfoMatykaDrive) return;
  const DATA_REGISTRY = root.InfoMatykaDataRegistry || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-data-registry.js') : null);
  const MERGE_CORE = root.InfoMatykaThreeWayMerge || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-three-way-merge.js') : null);
  if (!DATA_REGISTRY || !MERGE_CORE) throw new Error('Nie załadowano centralnego rejestru ani modułu three-way merge.');
  const MODULE_VERSION = '3.0.0';
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
    keepBoth(incoming, expected, localBlobs, remoteBlobs) {
      const makeId = prefix => prefix + '-' + this.crypto.randomUUID();
      const recoveredFolderId = makeId('folder-recovered');
      const folderIds = new Map(incoming.folders.map(folder => [folder.id, makeId('folder')]));
      const boardIds = new Map(incoming.boardIndex.map(board => [board.id, makeId('board')]));
      const assetIds = new Map(incoming.assets.map(asset => [asset.id, makeId('asset')]));
      const renameAssetReferences = value => {
        if (Array.isArray(value)) return value.map(renameAssetReferences);
        if (!object(value)) return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
          key === 'assetId' && assetIds.has(child) ? assetIds.get(child) : renameAssetReferences(child)]));
      };
      const recoveredFolders = incoming.folders.map(folder => ({ ...folder, id: folderIds.get(folder.id),
        parentId: folder.parentId ? folderIds.get(folder.parentId) : recoveredFolderId }));
      const recoveredIndex = incoming.boardIndex.map(board => ({ ...board, id: boardIds.get(board.id),
        name: 'Kopia — ' + board.name,
        folderId: board.folderId ? folderIds.get(board.folderId) : recoveredFolderId }));
      const recoveredBoards = incoming.boards.map(board => ({ id: boardIds.get(board.id),
        project: renameAssetReferences(board.project) }));
      const blobs = new Map([...localBlobs, ...remoteBlobs].map(asset => [asset.id, asset.blob]));
      const recoveredAssets = incoming.assets.map(asset => {
        const id = assetIds.get(asset.id), blob = blobs.get(asset.id);
        if (!(blob instanceof Blob)) throw new Error('Nie udało się przygotować assetu do zachowania obu wersji.');
        return { ...asset, id, blob };
      });
      const allAssetBlobs = new Map(localBlobs.map(asset => [asset.id, asset.blob]));
      const assets = [...expected.assets.map(asset => ({ ...asset, blob: allAssetBlobs.get(asset.id) })), ...recoveredAssets];
      if (assets.some(asset => !(asset.blob instanceof Blob))) throw new Error('Lokalna biblioteka zmieniła się. Porównaj wersje ponownie.');
      const combined = {
        ...expected,
        boards: [...expected.boards, ...recoveredBoards],
        boardIndex: [...expected.boardIndex, ...recoveredIndex],
        folders: [...expected.folders, { id: recoveredFolderId, name: 'Odzyskane z Google Drive – ' + new Date().toLocaleDateString('pl-PL') }, ...recoveredFolders],
        assets,
        meta: expected.meta
      };
      return this.transaction('readwrite', combined, expected);
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

  function mergeCategory(base, local, remote, category, now = Date.now) {
    const spec = CATEGORIES[category], merged = { local: Object.create(null) }, conflicts = [];
    const stats = { addedLocal: 0, addedRemote: 0, updatedLocal: 0, updatedRemote: 0, deleted: 0, conflicts: 0 };
    for (const key of spec.keys) {
      const dataset = DATA_REGISTRY.getByKey(key);
      const isProgressState = dataset.id === 'progress.state';
      const baselineSource = object(base.local[key]) ? base.local[key] : null;
      const xpBaseline = Number(baselineSource && (baselineSource.xpBaseline ?? baselineSource.xp) || 0);
      const hasProgressStateModel = isProgressState && [base.local[key], local.local[key], remote.local[key]].some(value =>
        object(value) && (has(value, 'xp') || has(value, 'xpBaseline') || object(value.stats) && has(value.stats, 'totalXp')));
      const mergeBase = isProgressState ? withoutDerivedProgress(base.local[key]) : base.local[key];
      const mergeLocal = isProgressState ? withoutDerivedProgress(local.local[key]) : local.local[key];
      const mergeRemote = isProgressState ? withoutDerivedProgress(remote.local[key]) : remote.local[key];
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
        if (!ownFiles[0].etag) throw new Error('Nie udało się potwierdzić wersji aktualnego pliku Drive. Nadpisanie zostało zatrzymane; porównaj wersje ponownie.');
        // Never overwrite another device's head. Web Locks serialize this device's tabs.
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
      if (duplicateDevices.length || baseCorrupt) action = 'conflict';
      else if (baseData && cloud.length) {
        remoteData = manifestData(cloud[0].data);
        const remoteConflicts = [];
        for (const record of cloud.slice(1)) {
          const remoteMerge = mergeCategory(baseData, remoteData, manifestData(record.data), category);
          remoteData = remoteMerge.merged;
          remoteConflicts.push(...remoteMerge.conflicts);
        }
        mergePreview = mergeCategory(baseData, manifestData(local), remoteData, category);
        mergePreview.conflicts.unshift(...remoteConflicts);
        mergePreview.stats.conflicts = mergePreview.conflicts.length;
        const mergedHash = await this.hash(mergePreview.merged);
        const remoteHash = await this.hash(remoteData);
        mergePreview.hash = mergedHash;
        action = mergePreview.conflicts.length ? 'conflict' :
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
      return { category, action, local, localHash, signature, cloud, files, base, mergePreview, remoteData, duplicateDevices, fileCount: files.length,
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
      if (!['merge', 'resolve', 'local', 'cloud'].includes(source)) return { ...review, action: 'conflict' };
      if (source === 'merge' && ((review.mergePreview && review.mergePreview.conflicts.length) ||
          (!review.mergePreview && !['push', 'pull'].includes(review.action)) || ['same', 'none', 'conflict'].includes(review.action))) {
        return { ...review, action: 'conflict' };
      }
      if (source === 'resolve' && (!review.mergePreview || !review.mergePreview.conflicts.length)) return { ...review, action: 'conflict' };
      if (source === 'local' && !['push', 'merge', 'conflict'].includes(review.action)) return { ...review, action: 'conflict' };
      if (source === 'cloud' && !cloud.length) return { ...review, action: 'conflict' };
      if (review.action === 'same' || review.action === 'none') return { category, action: review.action };

      let action = source === 'merge' ? review.action : source === 'resolve' ? 'merge' : source === 'local' ? 'push' : 'pull';
      const chosen = source === 'cloud' ? cloud.find(record => record.fileId === resolution.fileId) :
        action === 'pull' ? cloud[0] : null;
      if (source === 'cloud' && !chosen) return { ...review, action: 'conflict' };
      const ownFile = files.find(file => file.appProperties.device === this.device);
      const ownFiles = ownFile ? [ownFile] : [];
      if (action !== 'pull' && !ownFiles.length && files.length >= MAX_FILES) throw new Error('Osiągnięto limit 100 plików urządzeń. Nowe urządzenie nie może dodać zapisu w tej kategorii.');
      if (await this.hash(await this.capture(category)) !== localHash) throw new Error('Dane lokalne zmieniły się w trakcie synchronizacji. Spróbuj ponownie.');
      let vector = mergeClocks([...cloud.map(r => r.vector), ...(base && object(base.vector) ? [base.vector] : [])]);
      let incoming;
      let mergeResult = review.mergePreview;
      if (source === 'resolve') mergeResult = MERGE_CORE.resolveConflicts(review.mergePreview, resolution.choices);
      if ((source === 'merge' || source === 'resolve') && mergeResult) {
        incoming = { ...manifestData(mergeResult.merged), boardAssetBlobs: local.boardAssetBlobs || [] };
        incoming = await this.prepareBoardAssets(incoming, this.onProgress, local.boardAssetBlobs || []);
      } else if (action === 'pull') {
        incoming = await this.prepareBoardAssets(chosen.data, this.onProgress);
        vector = { ...chosen.vector };
      } else incoming = local;

      const nextHash = await this.hash(incoming);
      if (source !== 'merge' && action === 'push') {
        for (const remote of cloud) await this.backup(category, await this.prepareBoardAssets(remote.data), 'Google Drive przed wysłaniem wersji lokalnej');
      }
      await this.backup(category, local, 'Dane lokalne przed synchronizacją');
      if (source === 'merge') {
        for (const remote of cloud) await this.backup(category, await this.prepareBoardAssets(remote.data, null, local.boardAssetBlobs || []), 'Google Drive przed merge');
      }
      await this.assertReviewUnchanged(review);

      if (action !== 'pull') {
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
    async keepBothBoards(review, remoteRecord) {
      if (!remoteRecord || review.category !== 'boards') throw new Error('Nie wybrano chmurowej wersji tablic.');
      await this.assertReviewUnchanged(review);
      const incoming = await this.prepareBoardAssets(remoteRecord.data, this.onProgress);
      await this.assertReviewUnchanged(review);
      await this.backup('boards', review.local, 'Lokalnie przed zachowaniem obu wersji');
      await this.boards.keepBoth(incoming.boards, review.local.boards, review.local.boardAssetBlobs, incoming.boardAssetBlobs);
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
  const tabId = root.crypto.randomUUID ? root.crypto.randomUUID() : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const keyCategory = new Map(Object.entries(CATEGORIES).flatMap(([category, spec]) => spec.keys.map(key => [key, category])));
  const internalWrites = new Set(), loadedEpochs = Object.create(null), previousEpochs = Object.create(null);
  Object.keys(CATEGORIES).forEach(category => { loadedEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category); });
  let backgroundRunning = false, backgroundTimer = null, pageEdited = false, needsReload = false, refreshTimer = null;
  let previousInert = false, applyingInBackground = false, backgroundState = null, preparePromise = null;
  let sessionRequest = null, connectionChannel = null;
  const GROUPS = [
    { label: 'Konto i postępy', detail: 'Profil, dostępność, XP, odznaki, nauka i ulubione', categories: ['profile', 'progress', 'learning', 'favorites'] },
    { label: 'Generator i materiały', detail: 'Zestawy, własne zadania, projekty i materiały', categories: ['generator', 'materials'] },
    { label: 'Klasy i planowanie', detail: 'Dziennik, organizacja miejsc, raporty, wydarzenia, dyżury i dostosowania SPE', categories: ['teacher', 'organizer', 'calendar', 'duty', 'spe'] },
    { label: 'Tablice interaktywne', detail: 'Tablice, obrazy, foldery i powiązania', categories: ['boards'] }
  ];
  let token = null, account = null, ready = false, busy = false, authorizing = false, client = null, gisPromise = null;
  let engine, backupStore, baseStore, comparisons = [], recovery = [], panel, notice = '', upgradeNotice = '', applied = false, afterAuth = null, pendingDirection = null;
  let recoveryAccountSelection = '';
  let progressMessage = '';
  let cloudChoices = Object.create(null);
  let conflictChoices = Object.create(null);
  let prefs = { selected: Object.keys(CATEGORIES), selectionVersion: 3, syncMode: 'check-only', connectionActive: true, boundAccount: '', accountEmail: '', lastCheckAt: '' };
  try {
    const current = root.localStorage.getItem(SETTINGS_KEY);
    const stored = JSON.parse(current || '{}');
    const { background, automatic, fetchLatest, lastSync, ...savedPreferences } = stored;
    prefs = { ...prefs, ...savedPreferences, syncMode: ['manual', 'check-only'].includes(savedPreferences.syncMode) ? savedPreferences.syncMode : prefs.syncMode };
    if (stored.selectionVersion !== 3) prefs.selected = Object.keys(CATEGORIES);
    prefs.selectionVersion = 3;
  } catch (_) { }
  prefs.selected = Array.isArray(prefs.selected) ? prefs.selected.filter(k => has(CATEGORIES, k)) : Object.keys(CATEGORIES);
  prefs.selectionVersion = 3;
  const config = root.InfoMatykaDriveConfig || {};
  const configured = typeof config.clientId === 'string' && /^[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId);
  const connected = () => !!token && Date.now() < token.expiresAt && !!account;
  function savePrefs() { prefs.preferenceSchema = 3; root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); }
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
  function connectionNotice(fallback) { if (!upgradeNotice) return fallback; const message = upgradeNotice; upgradeNotice = ''; return message; }
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
    token = null; account = null; engine = null; comparisons = []; recovery = []; afterAuth = null;
    prefs.connectionActive = false; if (persist) savePrefs(); clearSession();
    clearTimeout(backgroundTimer); backgroundState = null; needsReload = false;
    Object.keys(CATEGORIES).forEach(category => { loadedEpochs[category] = root.localStorage.getItem(HYDRATION_PREFIX + category); });
    notice = 'Odłączono na tym urządzeniu. Dane na Drive pozostają zachowane.'; render();
  }
  function initializeAccount(user) {
    try { const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY)); if (latest && (!latest.boundAccount || latest.boundAccount === user.permissionId)) prefs = { ...prefs, ...latest }; } catch (_) { }
    account = user; recoveryAccountSelection = user.permissionId; comparisons = []; recovery = []; cloudChoices = Object.create(null);
    backgroundState = null;
    prefs.boundAccount = user.permissionId; prefs.accountEmail = user.emailAddress || ''; prefs.connectionActive = true; savePrefs(); saveSession();
    const device = root.localStorage.getItem(DEVICE_KEY) || root.crypto.randomUUID();
    root.localStorage.setItem(DEVICE_KEY, device);
    backupStore = getBackupStore();
    baseStore = getBaseStore();
    engine = new SyncEngine({ storage: root.localStorage, bases: baseStore, backups: backupStore,
      boards: new BoardStore(root.indexedDB, root.crypto, notifyBoardsChanged), crypto: root.crypto, transport, device, deviceName: prefs.deviceName || '', account: user.permissionId,
      beforeApply: () => {
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
        if (backgroundRunning && !panel && root.document.body && !applyingInBackground) {
          previousInert = root.document.body.inert; root.document.body.inert = true; applyingInBackground = true;
        }
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
        applied = true; if (backgroundRunning && !panel) needsReload = true;
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
      notice = connectionNotice('Połączono. Wybierz zakres i kliknij „Synchronizuj”.');
    } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
    finally { authorizing = false; render(); }
    if (connected() && prefs.selected.length && continuation) await synchronize();
    if (connected() && prefs.syncMode === 'check-only') scheduleBackground(2000);
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
          initializeAccount(user); notice = connectionNotice('Połączenie zachowane. Kliknij „Synchronizuj”, aby sprawdzić dane.');
        } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
        finally { authorizing = false; }
      } else clearSession();
      render();
      if (connected() && prefs.syncMode === 'check-only') scheduleBackground(2000);
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
    if (!target || !target.closest || target.closest('#infomatyka-drive-settings, #infomatyka-drive-refresh, #infomatyka-drive-background-status')) return;
    if (event.type === 'pointerdown' && !target.closest('button, canvas, [contenteditable="true"], input, textarea, select')) return;
    pageEdited = true; renewEditLease();
  }
  function checkEpoch(category) {
    return root.localStorage.getItem(HYDRATION_PREFIX + category) === loadedEpochs[category];
  }
  function guardWrite(category) {
    if (!category || internalWrites.has(category) || checkEpoch(category)) return;
    needsReload = true; renderBackgroundStatus();
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
    if (prefs.syncMode === 'check-only') scheduleBackground(2500);
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
    root.addEventListener('online', () => { render(); scheduleBackground(1000); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { renewEditLease(); if (needsReload && !pageEdited) scheduleRefresh(); else scheduleBackground(1000); }
    });
    root.addEventListener('pagehide', () => {
      clearTimeout(backgroundTimer); clearTimeout(refreshTimer);
      try { root.localStorage.removeItem(EDIT_PREFIX + tabId); } catch (_) { }
    });
    try {
      if (root.BroadcastChannel) {
        connectionChannel = new root.BroadcastChannel('infomatyka_boards');
        connectionChannel.onmessage = event => {
          const message = event.data;
          if (message === 'changed') { if (prefs.syncMode === 'check-only') scheduleBackground(2500); return; }
          if (!object(message)) return;
          if (message.type === 'session-request' && connected() && prefs.connectionActive && message.accountId === account.permissionId && message.clientId === config.clientId) {
            connectionChannel.postMessage({ type: 'session-response', nonce: message.nonce, token, accountId: account.permissionId, clientId: config.clientId });
          } else if (message.type === 'session-response' && sessionRequest && message.nonce === sessionRequest.nonce && message.accountId === prefs.boundAccount && message.clientId === config.clientId) {
            sessionRequest.accept(message);
          } else if (message.type === 'local-change' && message.accountId === prefs.boundAccount && prefs.syncMode === 'check-only') scheduleBackground(2500);
        };
      }
    } catch (_) { }
  }
  function scheduleBackground(delay = 2500) {
    if (prefs.syncMode !== 'check-only' || prefs.scopePending || prefs.reviewPending || !prefs.connectionActive || !connected() || !engine || needsReload || root.navigator.onLine === false) return;
    clearTimeout(backgroundTimer); backgroundTimer = setTimeout(() => { backgroundTimer = null; syncInBackground(); }, delay);
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
  async function syncInBackground() {
    if (busy || authorizing || prefs.syncMode !== 'check-only' || prefs.scopePending || prefs.reviewPending || !prefs.connectionActive || !connected() || !engine || needsReload || !prefs.selected.length || document.visibilityState !== 'visible' || root.navigator.onLine === false) return;
    busy = true; backgroundRunning = true; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', { ifAvailable: true }, async lock => {
        if (!lock) return;
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
        if (latest.syncMode !== 'check-only' || latest.scopePending || latest.reviewPending || latest.connectionActive === false || latest.boundAccount !== account.permissionId) return;
        const selected = prefs.selected.filter(category => (latest.selected || []).includes(category));
        const results = await inspectAll(selected);
        const errors = [], differences = [];
        results.forEach((result, index) => {
          if (result.error) errors.push({ category: selected[index], message: result.error });
          else if (differs(result)) differences.push(result.category);
        });
        backgroundState = { account: latest.boundAccount, checkedAt: new Date().toISOString(), differences, errors };
        if (panel && differences.length) {
          comparisons = results; cloudChoices = Object.create(null); notice = 'Wykryto zmiany. Sprawdź porównanie i wybierz, co zrobić.';
        } else if (panel && errors.length) comparisons = results;
      });
    } catch (e) { backgroundState = { account: prefs.boundAccount, checkedAt: new Date().toISOString(), differences: [], errors: [{ message: e.message }] }; }
    finally {
      busy = false; backgroundRunning = false;
      if (applyingInBackground && root.document.body) { root.document.body.inert = previousInert; applyingInBackground = false; }
      render(); if (needsReload) scheduleRefresh();
    }
  }
  function driveStatus(message, state = 'warning') { return { message, state }; }
  function backgroundStatus() {
    if (needsReload) return driveStatus('Drive: odśwież widok po pobraniu danych');
    if (!prefs.connectionActive) return null;
    if (notice && !ready && !connected()) return driveStatus('Drive: ' + notice, authorizing ? 'syncing' : 'error');
    if (root.navigator.onLine === false) return driveStatus('Drive: offline — dane pozostają lokalnie', 'offline');
    if (!connected()) return prefs.accountEmail ? driveStatus('Połączenie z Google Drive wygasło. Połącz ponownie.', 'warning') : null;
    if (prefs.syncMode === 'manual') return driveStatus('Drive: synchronizacja ręczna', 'info');
    if (prefs.scopePending || prefs.reviewPending) return driveStatus('Drive: dokończ wybór synchronizacji w ustawieniach');
    if (backgroundState && backgroundState.differences && backgroundState.differences.length) return driveStatus('Drive: są zmiany do porównania w ustawieniach');
    if (root.navigator.onLine === false) return driveStatus('Drive: offline — dane pozostają lokalnie', 'offline');
    if (backgroundState && backgroundState.errors && backgroundState.errors.length) return driveStatus('Drive: nie udało się sprawdzić zmian', 'error');
    if (backgroundRunning) return driveStatus('Drive: sprawdzanie zmian…', 'syncing');
    return backgroundState && backgroundState.checkedAt ?
      driveStatus('Drive: dane sprawdzone\n' + formatDate(backgroundState.checkedAt), 'success') :
      driveStatus('Drive: synchronizacja w tle włączona', 'info');
  }
  function backgroundMessage() { const status = backgroundStatus(); return status ? status.message : ''; }
  function renderBackgroundStatus() {
    if (!root.InfoMatykaDriveIndicator) return;
    const status = backgroundStatus();
    if (!status || panel) root.InfoMatykaDriveIndicator.hide();
    else root.InfoMatykaDriveIndicator.show(status);
  }
  function beginConnect(changeAccount = false, continuation = null) {
    if (!ready || busy || authorizing) return;
    token = null; account = null; engine = null; clearSession(); comparisons = []; recovery = []; cloudChoices = Object.create(null);
    afterAuth = continuation; authorizing = true; notice = 'Łączenie z Google Drive…'; render();
    try {
      client.requestAccessToken({ prompt: changeAccount || !prefs.accountEmail ? 'select_account' : '',
        ...(changeAccount || !prefs.accountEmail ? {} : { login_hint: prefs.accountEmail }) });
    } catch (e) { authorizing = false; afterAuth = null; notice = e.message; render(); }
  }
  const differs = review => !review.error && !['same', 'none'].includes(review.action);
  function chosenCloud(review) {
    if (!review.cloud.length) return null;
    const hashes = new Set(review.cloud.map(record => record.hash));
    if (hashes.size === 1) return review.cloud[0];
    return review.cloud.find(record => record.fileId === cloudChoices[review.category]) || null;
  }
  async function inspectAll(selected, verifyBoardAssets = false) {
    // Independent categories are read together; changing a checkbox never calls this.
    const results = await Promise.allSettled(selected.map(category => engine.inspect(category, { verifyBoardAssets })));
    const reviews = results.map((result, index) => result.status === 'fulfilled' ? result.value : { category: selected[index], error: result.reason.message });
    recordInspectionState(reviews);
    return reviews;
  }
  async function synchronize(source = null) {
    if (busy || authorizing || !prefs.selected.length) return;
    if (!connected() || !engine) { beginConnect(false, { synchronize: true }); return; }
    clearTimeout(backgroundTimer);
    prefs.scopePending = false; prefs.reviewPending = true; savePrefs();
    const selected = [...prefs.selected];
    const reviewed = comparisons.filter(review => selected.includes(review.category));
    busy = true; progressMessage = ''; notice = source ? 'Zastosowywanie wybranego działania…' : 'Porównywanie danych lokalnych i Google Drive…'; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
        if (latest.boundAccount !== account.permissionId || stable(latest.selected) !== stable(selected)) throw new Error('Konto lub zakres zmieniły się w innej karcie. Kliknij „Synchronizuj” ponownie.');
        const fresh = await inspectAll(selected, true);
        if (source) {
          // Validate the complete comparison before any category is changed.
          if (fresh.some(review => review.error) || fresh.some(review => {
            const previous = reviewed.find(item => item.category === review.category);
            return !previous || previous.localHash !== review.localHash || previous.signature !== review.signature;
          })) {
            comparisons = fresh; cloudChoices = Object.create(null);
            notice = 'Dane zmieniły się od czasu porównania. Sprawdź aktualne różnice i wybierz ponownie.'; return;
          }
          const changes = fresh.filter(review => source === 'merge' ? differs(review) && !review.mergePreview?.conflicts.length && review.action !== 'conflict' :
            source === 'resolve' ? review.action === 'conflict' && (review.mergePreview?.conflicts || []).every(conflict => conflictChoices[review.category + ':' + conflict.dataset + ':' + conflict.path]) :
            review.action === 'conflict');
          if (source === 'cloud' && changes.some(review => !chosenCloud(review))) {
            comparisons = fresh; notice = 'Wybierz wersję Drive w kategoriach z równoległymi zmianami.'; return;
          }
          const failures = []; let stale = false;
          for (const review of changes) {
            try {
              const result = await engine.sync(review.category, {
                signature: review.signature, localHash: review.localHash,
                source: source === 'merge' ? 'merge' : source === 'local' ? 'local' : 'cloud',
                ...(source === 'cloud' ? { fileId: chosenCloud(review).fileId } : {}),
                ...(source === 'resolve' ? { source: 'resolve', choices: Object.fromEntries((review.mergePreview?.conflicts || []).map(conflict => [
                  conflict.dataset + ':' + conflict.path, conflictChoices[review.category + ':' + conflict.dataset + ':' + conflict.path]
                ])) } : {})
              });
              if (result.action === 'conflict') stale = true;
              else if (!['same', 'none'].includes(result.action)) recordSuccessfulSync(review, result, chosenCloud(review));
            } catch (error) {
              root.console?.error('[InfoMatyka Drive] Błąd synchronizacji kategorii „' + review.category + '”', error);
              failures.push(CATEGORIES[review.category].label + ': ' + error.message);
            }
          }
          comparisons = failures.length || stale ? await inspectAll(selected) : [];
          cloudChoices = Object.create(null);
          notice = failures.length ? 'Nie udało się zakończyć wszystkich zmian. ' + failures.join(' ') : stale ?
            'Część danych zmieniła się podczas synchronizacji. Sprawdź nowe porównanie.' : source === 'merge' ?
            'Połączono bezpieczne zmiany. Konflikty pozostały bez zmian.' :
            source === 'resolve' ? 'Zastosowano wybrane wartości. Lokalne i Drive wersje sprzed zmiany zachowano w recovery.' :
            source === 'local' ? 'Zachowano wybrane lokalne wersje konfliktowych kategorii.' : 'Zachowano wybrane wersje Drive dla konfliktowych kategorii.';
        } else {
          comparisons = fresh; cloudChoices = Object.create(null);
          const conflictCount = comparisons.reduce((sum, review) => sum + (review.mergePreview?.conflicts.length || 0), 0);
          notice = comparisons.some(review => review.error) ? 'Nie udało się porównać wszystkich danych. Szczegóły poniżej.' : comparisons.some(differs) ?
            'Sprawdzenie ukończone. Bezpieczne zmiany można połączyć; wykryto ' + conflictCount + ' konfliktów wymagających decyzji.' : 'Dane są zgodne; nie trzeba niczego nadpisywać.';
        }
        prefs = { ...prefs, ...JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}'), lastCheckAt: new Date().toISOString() };
        prefs.reviewPending = comparisons.some(review => review.error || differs(review));
        savePrefs();
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
      recovery = []; comparisons = []; cloudChoices = Object.create(null); notice = 'Przywrócono kopię lokalną. Google Drive nie został zmieniony.';
      prefs.reviewPending = true; savePrefs();
    } catch (e) { notice = e.message; }
    finally { busy = false; render(); }
  }
  async function keepBothBoards() {
    const review = comparisons.find(item => item.category === 'boards'), remote = review && chosenCloud(review);
    if (!review || !remote || !connected() || busy) return;
    busy = true; progressMessage = ''; notice = 'Przygotowywanie odzyskanej kopii…'; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        const current = await engine.inspect('boards');
        if (current.localHash !== review.localHash || current.signature !== review.signature) {
          comparisons = await inspectAll(prefs.selected);
          throw new Error('Dane zmieniły się od czasu porównania. Sprawdź aktualne wersje i wybierz ponownie.');
        }
        await engine.keepBothBoards(review, remote);
        comparisons = await inspectAll(prefs.selected);
        cloudChoices = Object.create(null);
        prefs.reviewPending = comparisons.some(item => item.error || differs(item)); savePrefs();
        notice = 'Zachowano lokalne tablice i kopie wybranej wersji Drive w folderze „Odzyskane z Google Drive”. Google Drive nie został zmieniony.';
      });
    } catch (error) { notice = error.message; }
    finally { busy = false; progressMessage = ''; render(); }
  }
  function button(label, action, disabled = false, className = '') {
    const b = text('button', label, 'im-drive-button ' + className); b.type = 'button'; b.disabled = disabled || busy || authorizing; b.addEventListener('click', action); return b;
  }
  function formatBytes(bytes) {
    return bytes < 1024 ? bytes + ' B' : (bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString('pl-PL', { maximumFractionDigits: 2 }) + (bytes < 1024 * 1024 ? ' KiB' : ' MiB');
  }
  function conflictPathLabel(conflict) {
    const labels = { name: 'nazwa', title: 'tytuł', note: 'notatka', color: 'kolor', text: 'treść', content: 'treść',
      date: 'data', startTime: 'godzina rozpoczęcia', endTime: 'godzina zakończenia', order: 'kolejność', grade: 'ocena' };
    const parts = (conflict.displayPath || conflict.path).split('/').filter(Boolean).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const field = parts[parts.length - 1] || 'cały wpis';
    const entity = parts.length > 1 ? parts[parts.length - 2] : '';
    return (entity ? entity + ' · ' : '') + (labels[field] || field);
  }
  function conflictValueSummary(value, present) {
    if (!present) return 'Wartość została usunięta';
    if (value === null) return 'Brak wartości';
    if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    if (Array.isArray(value)) return value.length + ' elementów';
    if (object(value)) {
      const field = ['name', 'title', 'text', 'content', 'note', 'value'].find(key => typeof value[key] === 'string' || typeof value[key] === 'number');
      return field ? String(value[field]) : 'Zmieniony wpis';
    }
    return 'Brak wartości';
  }
  function formatDate(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pl-PL') : 'Data zapisu nieznana'; }
  function latestDate(values) { return values.filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0]; }
  function confirmDirection(source) {
    pendingDirection = source;
    render();
  }
  function renderDirectionConfirmation() {
    if (!pendingDirection) return null;
    const box = text('section', '', 'im-drive-confirmation');
    box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-live', 'assertive');
    const includesBoards = prefs.selected.includes('boards');
    const message = pendingDirection === 'local' ?
      (includesBoards ? 'Lokalna wersja zastąpi aktualną wersję tego urządzenia na Google Drive. Wersja z Google Drive zostanie wcześniej zachowana jako kopia bezpieczeństwa.' : 'Wybrane dane lokalne zastąpią wersję Google Drive. Przed zmianą zostanie zachowana lokalna kopia bezpieczeństwa.') :
      (includesBoards ? 'Google Drive zastąpi lokalną bibliotekę tablic na tym urządzeniu. Przed zmianą zostanie utworzona lokalna kopia bezpieczeństwa.' : 'Dane z Google Drive zastąpią wybrane dane lokalne. Przed zmianą zostanie zachowana lokalna kopia bezpieczeństwa.');
    box.append(text('p', message));
    const actions = text('div', '', 'im-drive-actions'), choice = pendingDirection;
    actions.append(button(choice === 'local' ? 'Wyślij wersję lokalną na Google Drive' : 'Pobierz i zastąp', () => {
      pendingDirection = null;
      synchronize(choice);
    }), button('Anuluj', () => { pendingDirection = null; render(); }, false, 'im-drive-secondary'));
    box.append(actions);
    return box;
  }
  function renderComparison() {
    const box = text('section', '', 'im-drive-comparison'); box.append(text('h4', 'Porównanie wybranych danych'));
    const valid = comparisons.filter(review => !review.error);
    const different = valid.filter(differs), remote = valid.flatMap(review => chosenCloud(review) || review.cloud[0] || []);
    const localBytes = valid.reduce((sum, review) => sum + review.localVersion.bytes, 0);
    const cloudBytes = remote.reduce((sum, record) => sum + (record.fileBytes || record.bytes), 0);
    const versions = text('div', '', 'im-drive-versions');
    const localCard = text('div', '', 'im-drive-version'); localCard.append(text('h5', 'Lokalnie'),
      text('p', valid.every(review => review.localVersion.empty) ? 'Brak zapisanych danych.' : 'Rozmiar manifestu: ' + formatBytes(localBytes)));
    const boardReview = valid.find(review => review.category === 'boards');
    const localDevice = boardReview ? boardReview.localVersion.device : (valid[0]?.localVersion.device || 'nieznane');
    localCard.append(text('p', 'Urządzenie: ' + (prefs.deviceName || ('Urządzenie ' + localDevice.slice(-4)))),
      text('p', 'ID urządzenia: ' + localDevice));
    const localSaved = latestDate(valid.map(review => review.localVersion.savedAt));
    if (boardReview) {
      const state = categoryState('boards');
      const lastBoardDate = state.lastLocalChangeAt || localSaved;
      localCard.append(text('p', 'Ostatnia zmiana lokalna: ' + (lastBoardDate ? formatDate(lastBoardDate) : 'data zapisu nieznana')),
        text('p', 'Ostatnie sprawdzenie: ' + (state.lastCheckedAt ? formatDate(state.lastCheckedAt) : 'brak') +
          ' · ostatnia udana synchronizacja: ' + (state.lastSuccessfulSyncAt ? formatDate(state.lastSuccessfulSyncAt) : 'brak')));
    } else if (localSaved) localCard.append(text('p', 'Ostatnia data zapisu w rekordach: ' + formatDate(localSaved)));
    if (boardReview) {
      const counts = boardReview.localVersion.counts;
      localCard.append(text('p', `Tablice: ${counts.boards} · foldery: ${counts.folders} · assety: ${counts.assets}`),
        text('p', 'Rozmiar assetów: ' + formatBytes(counts.assetBytes) + ' · hash: ' + boardReview.localHash),
        text('p', 'Vector clock: ' + JSON.stringify(boardReview.localVersion.vector)));
    }
    const cloudCard = text('div', '', 'im-drive-version'); cloudCard.append(text('h5', 'Na Google Drive'),
      text('p', remote.length ? 'Rozmiar manifestów: ' + formatBytes(cloudBytes) : 'Brak kopii w chmurze.'),
      text('p', remote.length ? 'Ostatnia zmiana Drive: ' + formatDate(latestDate(remote.map(record => record.savedAt))) : 'Rozmiar: 0 B'));
    const cloudBoard = remote.find(record => record.category === 'boards');
    if (cloudBoard) {
      const boards = cloudBoard.data.boards;
      const counts = { boards: boards.boardIndex.filter(row => !row.deletedAt).length, folders: boards.folders.length,
        assets: boards.assets.length, assetBytes: boards.assets.reduce((sum, asset) => sum + asset.size, 0) };
      cloudCard.append(text('p', 'Urządzenie źródłowe: ' + (cloudBoard.deviceName || ('Urządzenie ' + cloudBoard.device.slice(-4)))),
        text('p', 'ID urządzenia: ' + cloudBoard.device),
        text('p', `Tablice: ${counts.boards} · foldery: ${counts.folders} · assety: ${counts.assets}`),
        text('p', 'Rozmiar assetów: ' + formatBytes(counts.assetBytes) + ' · hash: ' + cloudBoard.hash),
        text('p', 'Drive version: ' + (cloudBoard.driveVersion || 'brak') + ' · vector clock: ' + JSON.stringify(cloudBoard.vector)));
    }
    versions.append(localCard, cloudCard); box.append(versions);
    const safeChanges = different.filter(review => ['push', 'pull', 'merge'].includes(review.action) && !review.mergePreview?.conflicts.length);
    const conflictReviews = different.filter(review => review.action === 'conflict' && review.mergePreview?.conflicts.length);
    const conflictCount = conflictReviews.reduce((sum, review) => sum + review.mergePreview.conflicts.length, 0);
    const hasComparisonErrors = comparisons.some(review => review.error);
    box.append(text('p', hasComparisonErrors ? 'Nie wszystkie dane udało się porównać. Szczegóły błędu są poniżej.' : safeChanges.length ? 'Gotowe do połączenia: ' + safeChanges.map(review => CATEGORIES[review.category].label +
      (review.mergePreview ? ' · ' + (review.mergePreview.stats.addedLocal + review.mergePreview.stats.addedRemote + review.mergePreview.stats.deleted) + ' zmian' : '')).join(' · ') :
      different.length ? 'Są zmiany wymagające sprawdzenia.' : 'Wersje są zgodne; nie trzeba niczego nadpisywać.', 'im-drive-help'));
    if (conflictCount) box.append(text('p', 'Konflikty: ' + conflictCount + ' pól wymagają decyzji. Zmiany lokalne i Drive są pokazane osobno; obie wersje zostaną zapisane w kopiach odzyskiwania przed zastosowaniem wyboru.', 'im-drive-status'));
    const detail = text('details', '', 'im-drive-details'); detail.append(text('summary', 'Szczegóły różnic i dat'));
    detail.open = hasComparisonErrors;
    comparisons.forEach(review => {
      if (review.error) { detail.append(text('p', CATEGORIES[review.category].label + ': ' + review.error, 'im-drive-status')); return; }
      review.duplicateDevices.forEach(duplicate => detail.append(text('p', CATEGORIES[review.category].label + ': wykryto kilka plików nagłówka urządzenia ' + duplicate.device + '. Synchronizacja tej kategorii jest zatrzymana; sprawdź pliki na Drive.', 'im-drive-status')));
      const record = chosenCloud(review) || review.cloud[0];
      const state = categoryState(review.category);
      const row = text('div', '', 'im-drive-diff-row'); row.append(text('strong', CATEGORIES[review.category].label),
        text('span', 'Lokalnie: ' + formatBytes(review.localVersion.bytes) + ' · ostatnia zmiana ' + (review.localVersion.savedAt ? formatDate(review.localVersion.savedAt) : 'nieznana') + ' · hash ' + review.localHash),
        text('span', record ? 'Drive: ' + formatBytes(record.fileBytes) + ' · ' + formatDate(record.savedAt) + ' · device ' + record.device + ' · hash ' + record.hash + ' · version ' + (record.driveVersion || 'brak') + ' · revision ' + (record.headRevisionId || 'brak') : 'Drive: brak kopii'),
        text('span', review.action === 'same' ? 'Zgodne' : review.action === 'none' ? 'Brak danych do synchronizacji' :
          !review.cloud.length ? 'Tylko lokalnie' : review.localVersion.empty ? 'Tylko na Drive' : 'Różna zawartość'),
        text('span', 'Stan: localDirty=' + state.localDirty + ' · remoteChanged=' + state.remoteChanged +
          ' · ostatnie sprawdzenie ' + (state.lastCheckedAt ? formatDate(state.lastCheckedAt) : 'brak') +
          ' · ostatnia udana synchronizacja ' + (state.lastSuccessfulSyncAt ? formatDate(state.lastSuccessfulSyncAt) : 'brak')));
      detail.append(row);
      if (review.mergePreview) {
        review.mergePreview.conflicts.forEach(conflict => {
          const dataset = DATA_REGISTRY.get(conflict.dataset), key = review.category + ':' + conflict.dataset + ':' + conflict.path;
          const item = text('div', '', 'im-drive-diff-row');
          item.append(text('strong', (dataset ? dataset.label : conflict.dataset) + ' · ' + conflictPathLabel(conflict)),
            text('span', 'Wspólna baza: ' + conflictValueSummary(conflict.base, conflict.basePresent)),
            text('span', 'To urządzenie: ' + conflictValueSummary(conflict.local, conflict.localPresent)),
            text('span', 'Google Drive: ' + conflictValueSummary(conflict.remote, conflict.remotePresent)));
          const choice = document.createElement('select'); choice.disabled = busy;
          const blank = text('option', 'Wybierz wersję zachowaną'); blank.value = ''; choice.append(blank);
          [['local', 'Zachowaj to urządzenie'], ['remote', 'Zachowaj Google Drive'], ['base', 'Przywróć wspólną bazę']].forEach(([value, label]) => {
            const option = text('option', label); option.value = value; choice.append(option);
          });
          choice.value = conflictChoices[key] || '';
          choice.addEventListener('change', () => { if (choice.value) conflictChoices[key] = choice.value; else delete conflictChoices[key]; render(); });
          item.append(choice); detail.append(item);
        });
      }
    }); box.append(detail);
    valid.filter(review => new Set(review.cloud.map(record => record.hash)).size > 1).forEach(review => {
      const label = text('label', 'Równoległe wersje: ' + CATEGORIES[review.category].label, 'im-drive-cloud-choice');
      const select = document.createElement('select'); select.disabled = busy;
      const initial = text('option', 'Wybierz kopię Drive'); initial.value = ''; select.append(initial);
      review.cloud.forEach(record => { const option = text('option', formatDate(record.savedAt) + ' · ' + formatBytes(record.bytes) + ' · urządzenie ' + record.device.slice(0, 8)); option.value = record.fileId; select.append(option); });
      select.value = cloudChoices[review.category] || ''; select.addEventListener('change', () => { cloudChoices[review.category] = select.value; render(); }); label.append(select); box.append(label);
    });
    const hasErrors = comparisons.some(review => review.error), needsCloud = different.filter(review => review.action === 'conflict' && review.cloud.length);
    if (different.some(review => review.localVersion.uploadBytes > MAX_BYTES)) box.append(text('p', 'Część danych przekracza limit zapisu. Szczegóły są w sekcji „Limity i kopie zapasowe”. Możesz wczytać mniejszą wersję z Drive.', 'im-drive-status'));
    if (different.length) {
      const actions = text('div', '', 'im-drive-actions');
      if (safeChanges.length) actions.append(button('Połącz bezpieczne zmiany (' + safeChanges.length + ')', () => synchronize('merge'),
        hasErrors || safeChanges.some(review => review.localVersion.uploadBytes > MAX_BYTES)));
      const unresolvedConflicts = conflictReviews.some(review => review.mergePreview.conflicts.some(conflict =>
        !conflictChoices[review.category + ':' + conflict.dataset + ':' + conflict.path]));
      if (conflictReviews.length) actions.append(button('Zastosuj wybrane rozstrzygnięcia (' + conflictCount + ')', () => synchronize('resolve'),
        hasErrors || unresolvedConflicts || conflictReviews.some(review => review.duplicateDevices.length || review.localVersion.uploadBytes > MAX_BYTES)));
      const boardsReview = different.find(review => review.category === 'boards' && review.action === 'conflict' && review.cloud.length);
      if (boardsReview) actions.append(button('Zachowaj obie wersje', keepBothBoards,
        hasErrors || boardsReview.duplicateDevices.length > 0 || (new Set(boardsReview.cloud.map(record => record.hash)).size > 1 && !chosenCloud(boardsReview))));
      box.append(actions, text('p', 'Sprawdzenie jest tylko do odczytu. Bezpieczne połączenie wymaga kliknięcia; rozstrzygnięcia zapisują kopie lokalne i Drive przed zmianą.', 'im-drive-help'));
    }
    if (pendingDirection) box.append(renderDirectionConfirmation());
    return box;
  }
  function render() {
    renderBackgroundStatus();
    if (!panel) return;
    panel.replaceChildren(); panel.append(text('h3', 'Synchronizacja z Google Drive'));
    panel.append(text('p', 'Zapisuj dane InfoMatyki na swoim Google Drive i przenoś je między urządzeniami. Aplikacja ma dostęp tylko do swojego prywatnego folderu, bez dostępu do Twoich dokumentów.'));
    const top = text('div', '', 'im-drive-toolbar');
    top.append(text('span', connected() ? 'Połączono: ' + (account.emailAddress || account.displayName) : prefs.accountEmail ? 'Konto: ' + prefs.accountEmail + ' · połączenie do odnowienia' : 'Najpierw zaloguj się do Google Drive.', 'im-drive-status'));
    top.append(button(connected() ? 'Zmień konto' : prefs.accountEmail ? 'Połącz ponownie' : 'Zaloguj się do Google Drive', () => beginConnect(connected()), !ready, 'im-drive-secondary'));
    if (connected()) top.append(button('Odłącz', disconnect, false, 'im-drive-secondary')); panel.append(top);
    const checkLabel = text('label', '', 'im-drive-choice'); const checkMode = document.createElement('input'); checkMode.type = 'checkbox';
    checkMode.checked = prefs.syncMode === 'check-only'; checkMode.disabled = busy || authorizing;
    checkMode.addEventListener('change', () => {
      prefs.syncMode = checkMode.checked ? 'check-only' : 'manual'; savePrefs();
      if (checkMode.checked) scheduleBackground(1000); else clearTimeout(backgroundTimer);
      render();
    });
    checkLabel.append(checkMode, text('span', 'Automatycznie sprawdzaj zmiany (bez wysyłania i pobierania)')); panel.append(checkLabel);
    panel.append(text('p', connected() ? backgroundMessage() || (prefs.syncMode === 'check-only' ? 'Automatyczne sprawdzanie jest tylko do odczytu. Każdy Push lub Pull wymaga osobnego wyboru.' : 'Tryb ręczny: porównaj dane i wybierz działanie przyciskiem poniżej.') : 'Po otwarciu strony Drive może zostać sprawdzony. Samo sprawdzanie nigdy nie zmienia lokalnych ani chmurowych danych.', 'im-drive-help'));
    const deviceLabel = text('label', '', 'im-drive-choice'); deviceLabel.append(text('span', 'Nazwa tego urządzenia'));
    const deviceName = document.createElement('input'); deviceName.type = 'text'; deviceName.maxLength = 60; deviceName.value = prefs.deviceName || '';
    deviceName.placeholder = 'Urządzenie ' + (root.localStorage.getItem(DEVICE_KEY) || '').slice(-4);
    deviceName.addEventListener('change', () => { prefs.deviceName = deviceName.value.trim().slice(0, 60); if (engine) engine.deviceName = prefs.deviceName; savePrefs(); });
    deviceLabel.append(deviceName); panel.append(deviceLabel);
    if (connected()) {
      const choices = document.createElement('fieldset'); choices.disabled = busy || authorizing; choices.className = 'im-drive-scope';
      choices.append(text('legend', 'Co synchronizować?'));
      const grid = text('div', '', 'im-drive-choice-grid');
      GROUPS.forEach(group => {
        const label = text('label', '', 'im-drive-choice im-drive-group'); const check = document.createElement('input'); check.type = 'checkbox';
        check.checked = group.categories.every(key => prefs.selected.includes(key)); check.indeterminate = !check.checked && group.categories.some(key => prefs.selected.includes(key));
        check.addEventListener('change', () => {
          prefs.selected = check.checked ? Object.keys(CATEGORIES).filter(key => prefs.selected.includes(key) || group.categories.includes(key)) : prefs.selected.filter(key => !group.categories.includes(key));
          prefs.scopePending = true; clearTimeout(backgroundTimer);
          comparisons = []; recovery = []; cloudChoices = Object.create(null); savePrefs(); notice = 'Zakres zmieniony. Kliknij „Synchronizuj”, aby porównać dane.'; render();
        });
        const caption = text('span', ''); caption.append(text('strong', group.label), text('small', group.detail)); label.append(check, caption); grid.append(label);
      }); choices.append(grid); panel.append(choices);
      panel.append(text('p', 'Wszystko jest domyślnie zaznaczone. Po zmianie zakresu sprawdzenie czeka na kliknięcie „Synchronizuj”.', 'im-drive-help'));
      panel.append(button(busy ? (progressMessage || 'Sprawdzanie…') : 'Synchronizuj', () => synchronize(), !prefs.selected.length));
      panel.append(text('p', 'Połączenie jest zachowane podczas przechodzenia między podstronami. Nowa karta tej samej przeglądarki może je przejąć od otwartej karty. Ważne do: ' + formatDate(new Date(token.expiresAt).toISOString()), 'im-drive-help'));
    } else if (!configured) panel.append(text('p', 'Administrator nie skonfigurował jeszcze połączenia Google Drive.', 'im-drive-help'));
    const status = text('p', progressMessage || notice, 'im-drive-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
    if (comparisons.length && connected()) panel.append(renderComparison());
    if (applied) panel.append(button('Odśwież widok po wczytaniu danych', () => root.location.reload()));
    const advanced = text('details', '', 'im-drive-details'); advanced.append(text('summary', 'Limity i kopie zapasowe'));
    advanced.append(text('p', 'Limity InfoMatyki: 8 MiB na manifest kategorii, 80 MiB na pojedynczy asset, 500 MiB assetów na bibliotekę, 100 manifestów urządzeń w kategorii oraz 5 lokalnych kopii na kategorię i konto. Kopie przechowują też assety i zajmują miejsce na urządzeniu.', 'im-drive-help'));
    comparisons.filter(review => !review.error).forEach(review => advanced.append(text('p', CATEGORIES[review.category].label + ': pliki ' + review.fileCount + '/100 · zapis lokalny ' + formatBytes(review.localVersion.uploadBytes) + '/8 MiB', 'im-drive-help')));
    const recoveryActions = text('div', '', 'im-drive-actions');
    const importInput = document.createElement('input'); importInput.type = 'file'; importInput.accept = '.imbackup,application/vnd.infomatyka.drive-recovery'; importInput.hidden = true;
    importInput.addEventListener('change', () => { if (importInput.files && importInput.files[0]) importRecovery(importInput.files[0]); importInput.value = ''; });
    recoveryActions.append(importInput,
      button('Pokaż kopie do przywrócenia', showRecovery, !root.localforage, 'im-drive-secondary'),
      button('Pobierz kopie lokalne', downloadRecovery, !root.localforage, 'im-drive-secondary'),
      button('Importuj kopie lokalne', () => importInput.click(), !root.localforage, 'im-drive-secondary'));
    advanced.append(recoveryActions);
    recovery.forEach(copy => advanced.append(button('Przywróć: ' + CATEGORIES[copy.category].label + ' · ' + formatDate(copy.at) + ' · ' + (copy.reason || 'kopia lokalna') + ' · ' + formatBytes(byteSize(copy.data)), () => restoreCopy(copy), false, 'im-drive-secondary')));
    panel.append(advanced); if (recovery.length) advanced.open = true;
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
  root.InfoMatykaDrive = { version: MODULE_VERSION, categories: CATEGORIES, synchronize: () => synchronize(), syncInBackground, disconnect,
    getDiagnostics, isConnected: connected, guardBoardWrite,
    isBusy: () => busy || authorizing,
    mount: async function (element) { panel = element; if (!client) preparePromise = null; render(); await prepare(); } };
  root.addEventListener('storage', event => {
    if (event.key === SETTINGS_KEY || event.key === null) {
      try {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY));
        if (!latest || latest.connectionActive === false || (account && latest.boundAccount !== account.permissionId)) { disconnect(false); return; }
        prefs = { ...prefs, ...latest }; comparisons = []; recovery = []; cloudChoices = Object.create(null); render(); scheduleBackground(2000);
      } catch (_) { disconnect(false); }
    } else if (event.key && event.key.startsWith(HYDRATION_PREFIX)) {
      const category = event.key.slice(HYDRATION_PREFIX.length);
      if (has(CATEGORIES, category) && !checkEpoch(category)) { needsReload = true; renderBackgroundStatus(); scheduleRefresh(); }
    } else if (keyCategory.has(event.key)) localChanged(keyCategory.get(event.key));
  });
  setInterval(() => {
    renewEditLease();
    if (token && !connected()) {
      token = null; account = null; engine = null; comparisons = []; clearSession();
      notice = 'Połączenie z Google Drive wygasło. Połącz ponownie.'; render();
    }
    if (connected() && prefs.syncMode === 'check-only') syncInBackground();
    if (needsReload) scheduleRefresh();
  }, 30000);
  function startRuntime() { panel = document.getElementById('infomatyka-drive-settings'); installObservers(); render(); prepare(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startRuntime); else startRuntime();
})(typeof window !== 'undefined' ? window : globalThis);
