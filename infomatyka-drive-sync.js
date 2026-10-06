/* InfoMatyka Cloud Save v5. */
(function (root) {
  'use strict';
  const DATA = root.InfoMatykaDataRegistry || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-data-registry.js') : null);
  const MERGE = root.InfoMatykaThreeWayMerge || (typeof module !== 'undefined' && module.exports ? require('./infomatyka-three-way-merge.js') : null);
  if (!DATA || !MERGE) throw new Error('Nie załadowano rejestru danych ani modułu łączenia.');
  const MODULE_VERSION = '5.0.0', SAVE_SCHEMA = 5, BOARD_SCHEMA = 4, BOARD_DB_VERSION = 4;
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata', SAVE_NAME = 'infomatyka-save.json';
  const SETTINGS_KEY = 'infomatyka-cloud-save-settings', SESSION_KEY = 'infomatyka-cloud-save-session';
  const DB_NAME = 'infomatyka-cloud-save', STORE_NAME = 'data', MAX_SAVE_BYTES = 8 * 1024 * 1024;
  const MAX_ASSET_BYTES = 80 * 1024 * 1024, MAX_ASSET_TOTAL_BYTES = 500 * 1024 * 1024, HISTORY_LIMIT = 5;
  const BOARD_STORES = ['boards', 'boardIndex', 'folders', 'assets', 'meta'];
  const SYNCABLE_META_IDS = new Set();
  const DATASETS = DATA.datasets.filter(item => item.syncStrategy !== 'none' && item.id !== 'boards.library');
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const isDeletedRow = row => object(row) && row.__deleted === true;
  const withoutBlob = asset => { const { blob, ...rest } = asset; return rest; };
  const isJsonOmitted = value => value === undefined || typeof value === 'function' || typeof value === 'symbol';
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(item => isJsonOmitted(item) ? 'null' : stable(item)).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).filter(key => !isJsonOmitted(value[key])).sort()
      .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function manifestData(snapshot) {
    if (!snapshot || !has(snapshot, 'boardAssetBlobs')) return snapshot;
    const { boardAssetBlobs, ...rest } = snapshot; return rest;
  }
  function stripDeleted(value) {
    if (Array.isArray(value)) return value.filter(item => !isDeletedRow(item)).map(stripDeleted);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripDeleted(item)]));
    return value;
  }
  function canonicalBoardSnapshot(data) {
    return Object.fromEntries(BOARD_STORES.map(name => [name,
      (data?.[name] || []).map(row => name === 'assets' ? withoutBlob(row) : row).sort((left, right) => left.id.localeCompare(right.id))]));
  }
  async function digest(value, cryptoAPI = root.crypto) {
    const bytes = new TextEncoder().encode(stable(manifestData(value)));
    return Array.from(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  const byteSize = value => new TextEncoder().encode(stable(manifestData(value))).length;
  function validateSnapshot(snapshot) {
    if (!object(snapshot) || !object(snapshot.datasets)) throw new Error('Zapis ma nieprawidłową strukturę.');
    for (const item of DATASETS) {
      if (!has(snapshot.datasets, item.id) || !DATA.validate(item.id, snapshot.datasets[item.id])) {
        throw new Error('Zapis zawiera nieprawidłowe dane: ' + item.label + '.');
      }
    }
    if (Object.keys(snapshot.datasets).length !== DATASETS.length) throw new Error('Zapis zawiera nieobsługiwane pola.');
    if (!snapshot.boards) throw new Error('Zapis nie zawiera biblioteki tablic.');
    validateBoards(snapshot.boards);
    return snapshot;
  }
  function validateSave(save) {
    if (!object(save) || save.app !== 'InfoMatyka' || save.schema !== SAVE_SCHEMA ||
        typeof save.revision !== 'string' || !save.revision || !object(save.datasets)) {
      throw new Error('Nie można odczytać danych zapisanych na Google Drive.');
    }
    validateSnapshot({ datasets: save.datasets, ...(save.boards ? { boards: save.boards } : {}) });
    return save;
  }
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
            if (stable(canonicalBoardSnapshot(snapshot)) !== stable(canonicalBoardSnapshot(expected))) {
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

  class DriveTransport {
    constructor(fetcher, tokenProvider, onUnauthorized) {
      this.fetcher = fetcher; this.tokenProvider = tokenProvider; this.onUnauthorized = onUnauthorized;
    }
    async request(path, options = {}, type = 'json') {
      const auth = this.tokenProvider();
      if (!auth || Date.now() >= auth.expiresAt) throw new Error('Sesja Google wygasła. Połącz ponownie.');
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
        const request = { ...options }; delete request.timeoutMs;
        try {
          response = await this.fetcher('https://www.googleapis.com/' + path, { ...request, signal: controller.signal,
            headers: { ...options.headers, Authorization: 'Bearer ' + auth.accessToken } });
        } finally { clearTimeout(timer); }
        if (response.ok || ['PATCH', 'POST'].includes(options.method) ||
            (response.status !== 429 && response.status < 500)) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
      if (!response.ok) {
        if (response.status === 401) { this.onUnauthorized?.(); throw new Error('Dostęp Google wygasł. Połącz ponownie.'); }
        if (response.status === 412) { const error = new Error('Zapis Drive zmienił się podczas operacji.'); error.code = 'DRIVE_CONFLICT'; throw error; }
        const error = new Error(response.status >= 500 || response.status === 429 ?
          'Google Drive jest chwilowo niedostępny. Zmiany pozostają lokalnie.' : 'Operacja Google Drive nie powiodła się (HTTP ' + response.status + ').');
        error.status = response.status; throw error;
      }
      if (type === 'blob') return response.blob();
      const text = await response.text();
      if (type === 'file') return { data: text ? JSON.parse(text) : null, etag: response.headers.get('ETag') };
      if (new TextEncoder().encode(text).length > MAX_SAVE_BYTES + 100000) throw new Error('Zapis Drive przekracza limit 8 MiB.');
      return text ? JSON.parse(text) : null;
    }
    async listAppDataFiles() {
      const files = [];
      let pageToken = '';
      do {
        const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name)' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await this.request('drive/v3/files?' + params);
        files.push(...(page.files || []));
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return files;
    }
    deleteFile(id) {
      return this.request('drive/v3/files/' + encodeURIComponent(id), { method: 'DELETE' });
    }
    async findSave() {
      const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '10',
        fields: 'files(id,name,size,modifiedTime,version)', q: "trashed = false and name = '" + SAVE_NAME + "'" });
      const files = (await this.request('drive/v3/files?' + params)).files || [];
      if (files.length > 1) throw new Error('Na Google Drive znaleziono więcej niż jeden główny zapis.');
      return files[0] || null;
    }
    async metadata(id) {
      const result = await this.request('drive/v3/files/' + encodeURIComponent(id) +
        '?fields=id,name,size,modifiedTime,version', {}, 'file');
      return { ...result.data, etag: result.etag };
    }
    readSave(id) { return this.request('drive/v3/files/' + encodeURIComponent(id) + '?alt=media'); }
    async listAssets(hashes) {
      const names = [...new Set(hashes)].map(hash => "name = 'infomatyka-asset-" + hash + "'").join(' or ');
      if (!names) return [];
      const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000',
        fields: 'files(id,name,size,mimeType)', q: 'trashed = false and (' + names + ')' });
      return (await this.request('drive/v3/files?' + params)).files || [];
    }
    readAsset(file) { return this.request('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media', { timeoutMs: 180000 }, 'blob'); }
    async writeAsset(asset, blob) {
      const boundary = 'im_asset_' + asset.sha256.slice(0, 24);
      const metadata = { name: 'infomatyka-asset-' + asset.sha256, mimeType: asset.mime, parents: ['appDataFolder'],
        appProperties: { sha256: asset.sha256, mime: asset.mime } };
      const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: ' + asset.mime + '\r\n\r\n',
        blob, '\r\n--' + boundary + '--']);
      return this.request('upload/drive/v3/files?uploadType=multipart&fields=id,name,size', { method: 'POST',
        timeoutMs: 180000, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    }
    async writeSave(content, file, version) {
      if (file && !file.etag) {
        const latest = await this.metadata(file.id);
        if (String(latest.version || '') !== String(version || '')) {
          const error = new Error('Google Drive zmienił się podczas synchronizacji.'); error.code = 'DRIVE_CONFLICT'; throw error;
        }
      }
      if (file) return this.request('upload/drive/v3/files/' + encodeURIComponent(file.id) +
        '?uploadType=media&fields=id,version,modifiedTime,size', { method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...(file.etag ? { 'If-Match': file.etag } : {}) }, body: content });
      const boundary = 'im_cloud_save_v5';
      const metadata = { name: SAVE_NAME, mimeType: 'application/json', parents: ['appDataFolder'] };
      const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' +
        content + '\r\n--' + boundary + '--';
      return this.request('upload/drive/v3/files?uploadType=multipart&fields=id,version,modifiedTime,size',
        { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    }
  }

  function emptySnapshot() { return { datasets: Object.fromEntries(DATASETS.map(item => [item.id, null])), boards: { boards: [], boardIndex: [], folders: [], assets: [], meta: [] } }; }
  function isEmpty(snapshot) {
    const values = [...Object.values(snapshot.datasets || {}), ...(snapshot.boards ? Object.values(snapshot.boards).filter(Array.isArray) : [])];
    return values.every(value => value == null || (Array.isArray(value) && !value.length) || (object(value) && !Object.keys(value).length));
  }
  function progressBaseline(state, events) {
    const total = Number(state?.xp ?? state?.stats?.totalXp) || 0;
    const baseline = Number(state?.xpBaseline);
    return Number.isFinite(baseline) ? baseline : total - (Array.isArray(events) ? events.reduce((sum, row) => sum + (Number(row.deltaXp) || 0), 0) : 0);
  }
  function mergeSnapshots(base, local, remote) {
    const shared = base || emptySnapshot(), merged = { datasets: {} };
    for (const dataset of DATASETS) {
      const result = MERGE.mergeThreeWay(shared.datasets[dataset.id], local.datasets[dataset.id], remote.datasets[dataset.id],
        { dataset: dataset.id, strategy: dataset.syncStrategy });
      const choices = Object.fromEntries(result.conflicts.map(conflict => [dataset.id + ':' + conflict.path, 'remote']));
      merged.datasets[dataset.id] = result.conflicts.length ? MERGE.resolveConflicts(result, choices).merged : result.merged;
    }
    if (local.boards || remote.boards) {
      const result = MERGE.mergeThreeWay(shared.boards || emptySnapshot().boards, local.boards || emptySnapshot().boards,
        remote.boards || emptySnapshot().boards, { dataset: 'boards.library', strategy: 'nested-entity-three-way' });
      const choices = Object.fromEntries(result.conflicts.map(conflict => ['boards.library:' + conflict.path, 'remote']));
      merged.boards = result.conflicts.length ? MERGE.resolveConflicts(result, choices).merged : result.merged;
      validateBoards(merged.boards);
    }
    const state = merged.datasets['progress.state'], events = merged.datasets['progress.events'];
    if (object(state) && (Array.isArray(events) || has(state, 'xp'))) {
      const baseline = progressBaseline(shared.datasets['progress.state'], shared.datasets['progress.events']);
      const xp = baseline + (Array.isArray(events) ? events.reduce((sum, row) => sum + (Number(row.deltaXp) || 0), 0) : 0);
      state.xpBaseline = baseline; state.xp = xp; state.stats = { ...(state.stats || {}), totalXp: xp };
    }
    return merged;
  }

  class CloudSaveEngine {
    constructor(options) { Object.assign(this, options); }
    baseKey() { return 'base:' + this.account; }
    historyKey() { return 'history:' + this.account; }
    async loadState() { return await this.store.getItem(this.baseKey()) || null; }
    async saveState(state) { await this.store.setItem(this.baseKey(), state); }
    async clearRemoteBase() { await this.store.removeItem(this.baseKey()); }
    async hash(snapshot) { return digest(snapshot, this.crypto); }
    async capture(verifyAssets = false) {
      const datasets = {};
      for (const dataset of DATASETS) {
        let value = null, raw = this.storage.getItem(dataset.key);
        if (raw !== null) { try { value = JSON.parse(raw); } catch (_) { throw new Error('Dane „' + dataset.label + '” nie zawierają JSON.'); } }
        if (!DATA.validate(dataset.id, value)) throw new Error('Dane „' + dataset.label + '” nie przechodzą walidacji.');
        datasets[dataset.id] = value;
      }
      const boards = await this.boards.capture(verifyAssets);
      return { datasets, boards: boards.data, boardAssetBlobs: boards.assetBlobs };
    }
    async addHistory(snapshot, reason) {
      const list = await this.store.getItem(this.historyKey()) || [];
      const copy = { id: this.crypto.randomUUID(), createdAt: new Date().toISOString(), reason, bytes: byteSize(snapshot), snapshot };
      await this.store.setItem(this.historyKey(), [copy, ...list].slice(0, HISTORY_LIMIT));
    }
    async listHistory() { return await this.store.getItem(this.historyKey()) || []; }
    async inspect() {
      const local = await this.capture(), localHash = await this.hash(local), state = await this.loadState();
      let file = null;
      if (state?.fileId) {
        try { file = await this.transport.metadata(state.fileId); } catch (error) { if (error.status !== 404) throw error; }
      }
      if (!file) file = await this.transport.findSave();
      let remote = null, remoteHash = null;
      if (file) {
        const version = String(file.version || '');
        if (state?.fileId === file.id && state.remoteVersion === version && state.snapshot &&
            state.baseHash === await this.hash(state.snapshot)) {
          remote = state.snapshot; remoteHash = state.baseHash;
        } else {
          const save = validateSave(await this.transport.readSave(file.id));
          remote = { datasets: save.datasets, ...(save.boards ? { boards: save.boards } : {}) };
          remoteHash = await this.hash(remote);
        }
      }
      const base = state?.snapshot || null, baseHash = base ? await this.hash(base) : null;
      const shrinkWarning = !!base && !isEmpty(base) && byteSize(local) < byteSize(base) * 0.3;
      let action;
      if (!remote) action = base ? 'conflict' : 'push';
      else if (!base) action = isEmpty(local) ? 'pull' : localHash === remoteHash ? 'same' : 'conflict';
      else if (shrinkWarning && localHash !== baseHash && remoteHash === baseHash) action = 'conflict';
      else if (localHash === baseHash && remoteHash === baseHash) action = 'same';
      else if (localHash !== baseHash && remoteHash === baseHash) action = 'push';
      else if (localHash === baseHash && remoteHash !== baseHash) action = 'pull';
      else if (localHash === remoteHash) action = 'same';
      else action = 'conflict';
      const signature = stable({ id: file?.id, version: String(file?.version || ''), etag: file?.etag, baseHash, localHash, remoteHash });
      return { action, local, localHash, base, baseHash, remote, remoteHash, file, signature, shrinkWarning,
        localBytes: byteSize(local), remoteBytes: file ? Number(file.size) || byteSize(remote) : 0 };
    }
    async prepareAssets(snapshot, preferred = []) {
      if (!snapshot.boards) return snapshot;
      const active = snapshot.boards.assets.filter(asset => !isDeletedRow(asset)), byId = new Map(preferred.map(row => [row.id, row.blob]));
      const files = await this.transport.listAssets(active.map(row => row.sha256));
      const byHash = new Map(files.map(file => [file.name.replace('infomatyka-asset-', ''), file])), blobs = [];
      let total = 0;
      for (const asset of active) {
        let blob = byId.get(asset.id);
        if (!await validateAssetBlob(asset, blob, this.crypto)) {
          const file = byHash.get(asset.sha256); if (file) blob = await this.transport.readAsset(file);
        }
        if (!await validateAssetBlob(asset, blob, this.crypto)) throw new Error('Brakuje poprawnego obrazu lub dokumentu tablic.');
        total += blob.size; if (total > MAX_ASSET_TOTAL_BYTES) throw new Error('Załączniki przekraczają limit 500 MiB.');
        blobs.push({ id: asset.id, blob });
      }
      return { ...snapshot, boardAssetBlobs: blobs };
    }
    async uploadAssets(snapshot) {
      if (!snapshot.boards) return;
      const active = snapshot.boards.assets.filter(asset => !isDeletedRow(asset));
      const local = new Map((snapshot.boardAssetBlobs || []).map(row => [row.id, row.blob]));
      const files = await this.transport.listAssets(active.map(row => row.sha256));
      const hashes = new Set(files.map(file => file.name.replace('infomatyka-asset-', '')));
      for (const asset of active) {
        if (hashes.has(asset.sha256)) continue;
        const blob = local.get(asset.id);
        if (!await validateAssetBlob(asset, blob, this.crypto)) throw new Error('Załącznik tablic zmienił się lub jest uszkodzony.');
        await this.transport.writeAsset(asset, blob); hashes.add(asset.sha256);
      }
    }
    async commitBase(snapshot, file, response) {
      const durable = manifestData(snapshot);
      await this.saveState({ fileId: response?.id || file?.id || null,
        remoteVersion: String(response?.version || file?.version || ''), baseHash: await this.hash(durable),
        lastSyncAt: new Date().toISOString(), lastRemoteModifiedAt: response?.modifiedTime || file?.modifiedTime || null,
        snapshot: durable });
    }
    async applySnapshot(incoming, before) {
      applying = true;
      try {
        for (const dataset of DATASETS) DATA.apply(dataset.id, stripDeleted(incoming.datasets[dataset.id]), { storage: this.storage });
        if (incoming.boards) await this.boards.replace(stripDeleted(incoming.boards), stripDeleted(before.boards), incoming.boardAssetBlobs || []);
      } catch (error) {
        for (const dataset of DATASETS) { try { DATA.apply(dataset.id, before.datasets[dataset.id], { storage: this.storage }); } catch (_) {} }
        throw error;
      } finally { applying = false; }
      if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new CustomEvent('infomatyka:data-changed', { detail: { dataset: 'cloud-save-apply' } }));
      if (root.dispatchEvent && root.Event) root.dispatchEvent(new Event('infomatyka_progress_updated'));
    }
    async resolve(choice, reviewed) {
      const review = object(reviewed) ? reviewed : await this.inspect();
      if (typeof reviewed === 'string' && reviewed !== review.signature) return { ...review, action: 'conflict', stale: true };
      if (review.action === 'same') {
        if (review.remote && (!review.base || review.baseHash !== review.remoteHash)) await this.commitBase(review.remote, review.file, review.file);
        return review;
      }
      choice = choice || (review.action === 'pull' ? 'remote' : 'local');
      if (!['remote', 'local', 'merge'].includes(choice)) throw new Error('Nieznana decyzja synchronizacji.');
      if (choice === 'remote' && !review.remote) throw new Error('Google Drive nie ma zapisu do pobrania.');
      let incoming = choice === 'remote' ? review.remote : review.local;
      if (choice === 'merge') {
        if (!review.remote) throw new Error('Nie ma drugiej wersji do połączenia.');
        incoming = mergeSnapshots(review.base, review.local, review.remote);
        incoming.boardAssetBlobs = review.local.boardAssetBlobs || [];
      }
      if (choice === 'remote' || choice === 'merge') incoming = await this.prepareAssets(incoming, review.local.boardAssetBlobs || []);
      await this.addHistory(review.local, 'Dane lokalne przed synchronizacją');
      if (review.remote && choice !== 'remote') await this.addHistory(
        await this.prepareAssets(review.remote, review.local.boardAssetBlobs || []), 'Google Drive przed zmianą');
      if (choice === 'remote') {
        await this.applySnapshot(incoming, review.local);
        await this.commitBase(manifestData(incoming), review.file, review.file);
        return { ...review, action: 'pull' };
      }
      if (choice === 'merge') await this.applySnapshot(incoming, review.local);
      await this.uploadAssets(incoming);
      const save = { app: 'InfoMatyka', schema: SAVE_SCHEMA, revision: this.crypto.randomUUID(),
        updatedAt: new Date().toISOString(), updatedBy: { deviceId: this.device, deviceName: this.deviceName || 'To urządzenie' },
        datasets: incoming.datasets, ...(incoming.boards ? { boards: incoming.boards } : {}) };
      validateSave(save);
      const content = stable(save);
      if (new TextEncoder().encode(content).length > MAX_SAVE_BYTES) throw new Error('Zapis przekracza limit 8 MiB.');
      const result = await this.transport.writeSave(content, review.file, review.file?.version);
      await this.commitBase(incoming, result || review.file, result);
      return { ...review, action: choice === 'merge' ? 'merge' : 'push' };
    }
    async restore(id) {
      const copy = (await this.listHistory()).find(item => item.id === id);
      if (!copy) throw new Error('Nie znaleziono wybranej kopii.');
      const current = await this.capture(); await this.addHistory(current, 'Bieżące dane przed przywróceniem');
      const incoming = await this.prepareAssets(copy.snapshot, current.boardAssetBlobs || []);
      await this.applySnapshot(incoming, current); root.InfoMatykaCloudSave.markDirty();
    }
  }

  function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
  function zipStore(entries) {
    const enc = new TextEncoder(), local = [], central = []; let offset = 0;
    for (const entry of entries) {
      const name = enc.encode(entry.name), bytes = entry.bytes, crc = crc32(bytes);
      const head = new Uint8Array(30 + name.length), view = new DataView(head.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
      view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
      view.setUint16(26, name.length, true); head.set(name, 30); local.push(head, bytes);
      const dir = new Uint8Array(46 + name.length), dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x800, true); dv.setUint32(16, crc, true); dv.setUint32(20, bytes.length, true);
      dv.setUint32(24, bytes.length, true); dv.setUint16(28, name.length, true); dv.setUint32(42, offset, true);
      dir.set(name, 46); central.push(dir); offset += head.length + bytes.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }
  async function makeBackup(snapshot) {
    const save = { app: 'InfoMatyka', schema: SAVE_SCHEMA, exportedAt: new Date().toISOString(),
      datasets: snapshot.datasets, ...(snapshot.boards ? { boards: snapshot.boards } : {}) };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const blobs = snapshot.boardAssetBlobs || [];
    if (!blobs.length) return { filename: 'infomatyka-backup-' + stamp + '.json',
      blob: new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }) };
    const byId = new Map(blobs.map(item => [item.id, item.blob]));
    const entries = [{ name: 'save.json', bytes: new Uint8Array(await new Blob([JSON.stringify(save)]).arrayBuffer()) }];
    for (const asset of snapshot.boards.assets.filter(item => !isDeletedRow(item))) {
      const blob = byId.get(asset.id); if (!blob) throw new Error('Kopia tablic nie zawiera wszystkich plików.');
      entries.push({ name: 'assets/' + asset.sha256, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return { filename: 'infomatyka-backup-' + stamp + '.zip', blob: zipStore(entries) };
  }
  function formatBytes(value) {
    if (!value) return '0 B'; const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
    return (value / Math.pow(1024, unit)).toFixed(unit ? 2 : 0) + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
  }
  function formatDate(value) { return value ? new Date(value).toLocaleString('pl-PL') : 'brak zapisu'; }
  let token = null, account = null, engine = null, tokenClient = null, gisPromise = null, store = null, panel = null, review = null;
  let preferences = {}, notice = 'Dane zapisują się lokalnie.', busy = false, applying = false, historyOpen = false, historyItems = [], timer = null;
  const config = root.InfoMatykaDriveConfig || {};
  const transport = new DriveTransport(root.fetch.bind(root), () => token, () => { token = null; clearSession(); notice = 'Połącz ponownie z Google Drive.'; render(); });
  const connected = () => !!token && Date.now() < token.expiresAt;
  function loadPrefs() { try { preferences = JSON.parse(root.localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { preferences = {}; } }
  function savePrefs() { root.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ accountId: account?.permissionId || preferences.accountId || '', email: account?.emailAddress || preferences.email || '', connectionActive: !!account })); }
  function clearSession() { try { root.sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
  function saveSession() { try { root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ clientId: config.clientId, accountId: account.permissionId, token })); } catch (_) {} }
  function render() {
    if (panel) {
      panel.replaceChildren();
      const title = document.createElement('h3'); title.textContent = 'Zapis w chmurze';
      const heading = document.createElement('div'); heading.className = 'im-drive-heading';
      const deleteButton = document.createElement('button'); deleteButton.type = 'button';
      deleteButton.className = 'im-drive-button im-drive-secondary im-drive-trash-button';
      deleteButton.setAttribute('aria-label', 'Usuń wszystkie dane InfoMatyki z Google Drive');
      deleteButton.title = connected() ? 'Usuń wszystkie dane InfoMatyki z Google Drive' : 'Połącz Google Drive, aby usunąć dane';
      deleteButton.disabled = busy || !connected(); deleteButton.onclick = deleteCloudData;
      deleteButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
      heading.append(title, deleteButton);
      const status = document.createElement('p'); status.className = 'im-drive-status'; status.setAttribute('role', 'status'); status.textContent = notice;
      const actions = document.createElement('div'); actions.className = 'im-drive-actions';
      const add = (label, fn, secondary) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'im-drive-button' + (secondary ? ' im-drive-secondary' : ''); button.textContent = label; button.disabled = busy; button.onclick = fn; actions.append(button); };
      if (!connected()) add('Połącz Google Drive', connect); else { add('Synchronizuj teraz', synchronize); add('Odłącz Google Drive', disconnect, true); }
      add(historyOpen ? 'Ukryj historię danych' : 'Historia danych', async () => { historyOpen = !historyOpen; historyItems = engine ? await engine.listHistory() : []; render(); }, true);
      add('Pobierz kopię lokalną', downloadLocalBackup, true);
      panel.append(heading, status, actions);
      if (historyOpen) for (const copy of historyItems) {
        const row = document.createElement('div'); row.className = 'im-drive-toolbar';
        const label = document.createElement('span'); label.textContent = formatDate(copy.createdAt) + ' · ' + formatBytes(copy.bytes) + ' · ' + (copy.reason || '');
        const restore = document.createElement('button'); restore.className = 'im-drive-button im-drive-secondary'; restore.textContent = 'Przywróć'; restore.onclick = () => restoreHistory(copy);
        row.append(label, restore); panel.append(row);
      }
    }
    root.dispatchEvent(new CustomEvent('infomatyka:cloud-save-status', { detail: { connected: connected(), account: account?.emailAddress || '', message: notice, busy } }));
  }
  function closeConflict() { root.document.getElementById('infomatyka-cloud-conflict')?.remove(); }
  function ensureConflictStyles() {
    if (root.document.getElementById('infomatyka-cloud-conflict-styles')) return;
    const style = document.createElement('style'); style.id = 'infomatyka-cloud-conflict-styles';
    style.textContent = '#infomatyka-cloud-conflict .im-drive-versions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:.75rem}' +
      '#infomatyka-cloud-conflict .im-drive-version{padding:1rem;border:1px solid #cbd5e1;border-radius:.65rem;background:#f8fafc;color:#1e293b;overflow-wrap:anywhere}' +
      '#infomatyka-cloud-conflict .im-drive-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1rem}' +
      '#infomatyka-cloud-conflict .im-drive-button{background:#0f766e;color:#fff;border:0;border-radius:.65rem;padding:.6rem .9rem;cursor:pointer;font:inherit;white-space:normal}' +
      '#infomatyka-cloud-conflict .im-drive-button:hover{background:#115e59}' +
      '#infomatyka-cloud-conflict .im-drive-button:focus-visible{outline:3px solid #0891b2;outline-offset:3px}' +
      '#infomatyka-cloud-conflict .im-drive-secondary{background:#fff;color:#115e59;border:1px solid #99f6e4;padding:.4rem .65rem}' +
      '#infomatyka-cloud-conflict .im-drive-secondary:hover{background:#ccfbf1}';
    document.head.append(style);
  }
  function showConflict(data) {
    closeConflict();
    const layer = document.createElement('div'); layer.id = 'infomatyka-cloud-conflict'; layer.setAttribute('role', 'presentation');
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '100000', background: '#0f172a99', display: 'grid', placeItems: 'center', padding: '1rem' });
    const box = document.createElement('section'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    Object.assign(box.style, { background: 'white', color: '#1e293b', borderRadius: '1rem', padding: '1.25rem', width: 'min(100%, 42rem)' });
    const h = document.createElement('h2'); h.textContent = 'Konflikt zapisu w chmurze';
    const p = document.createElement('p'); p.textContent = data.shrinkWarning ? 'Dane lokalne są znacznie mniejsze niż ostatnia zsynchronizowana wersja.' : 'Dane na tym urządzeniu różnią się od danych na Google Drive.';
    const versions = document.createElement('div'); versions.className = 'im-drive-versions';
    for (const label of ['Google Drive · ' + formatDate(data.file?.modifiedTime) + ' · ' + formatBytes(data.remoteBytes), 'To urządzenie · ' + formatDate(new Date().toISOString()) + ' · ' + formatBytes(data.localBytes)]) { const card = document.createElement('div'); card.className = 'im-drive-version'; card.textContent = label; versions.append(card); }
    const actions = document.createElement('div'); actions.className = 'im-drive-actions im-drive-global-actions';
    const choices = data.remote
      ? [['Użyj danych Google Drive', 'remote'], ['Użyj danych z tego urządzenia', 'local'], ['Połącz dane', 'merge']]
      : [['Zapisz dane lokalne na Google Drive', 'local']];
    for (const [label, action] of choices) { const b = document.createElement('button'); b.className = 'im-drive-button im-drive-secondary'; b.textContent = label; b.onclick = () => resolveConflict(action); actions.append(b); }
    const backup = document.createElement('button'); backup.className = 'im-drive-button im-drive-secondary'; backup.textContent = 'Pobierz kopię lokalną'; backup.onclick = downloadLocalBackup; actions.append(backup);
    box.append(h, p, versions, actions); layer.append(box); document.body.append(layer);
  }
  async function resolveConflict(choice) {
    if (!engine || !review || busy) return; busy = true; notice = 'Zapisywanie wybranej wersji…'; render();
    try {
      const result = await engine.resolve(choice, review.signature);
      if (result.action === 'conflict') { review = result; notice = 'Dane zmieniły się. Sprawdź konflikt ponownie.'; showConflict(result); }
      else { review = null; closeConflict(); notice = 'Zsynchronizowano wybraną wersję.'; }
    } catch (error) {
      notice = error.message;
      if (error.code === 'DRIVE_CONFLICT') { review = await engine.inspect(); showConflict(review); }
    } finally { busy = false; render(); }
  }
  async function syncLocked() {
    const current = await engine.inspect();
    if (current.action === 'conflict') { review = current; notice = current.shrinkWarning ? 'Dane lokalne są znacznie mniejsze od zapisanej wersji.' : 'Wymagana decyzja dotycząca różnych wersji danych.'; showConflict(current); return; }
    if (current.action === 'same') { if (current.remote && (!current.base || current.baseHash !== current.remoteHash)) await engine.commitBase(current.remote, current.file, current.file); review = null; notice = 'Zsynchronizowano.'; return; }
    const result = await engine.resolve(current.action === 'pull' ? 'remote' : 'local', current);
    if (result.action === 'conflict') { review = result; showConflict(result); notice = 'Google Drive zmienił się podczas synchronizacji.'; }
    else { review = null; closeConflict(); notice = 'Zsynchronizowano.'; }
  }
  async function synchronize() {
    if (!root.navigator.onLine) { notice = 'Offline. Zmiany zapisane lokalnie.'; render(); return; }
    if (busy) return;
    if (!connected() || !engine) { connect(); return; }
    busy = true; notice = 'Sprawdzanie Google Drive…'; render();
    try { if (root.navigator.locks) await root.navigator.locks.request('infomatyka-cloud-save-v5', syncLocked); else await syncLocked(); }
    catch (error) {
      notice = error.message;
      if (error.code === 'DRIVE_CONFLICT' && connected()) {
        try { review = await engine.inspect(); if (review.action === 'conflict') showConflict(review); }
        catch (inspectionError) { notice = inspectionError.message; }
      }
    }
    finally { busy = false; render(); }
  }
  async function downloadLocalBackup() {
    try {
      const backup = await makeBackup(await engine.capture(true));
      const url = URL.createObjectURL(backup.blob), link = document.createElement('a');
      link.href = url; link.download = backup.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { notice = error.message; render(); }
  }
  async function restoreHistory(copy) {
    if (busy || !engine) return; busy = true;
    try { await engine.restore(copy.id); notice = 'Przywrócono kopię lokalną. Zmiany zostaną sprawdzone przed wysłaniem.'; historyItems = await engine.listHistory(); }
    catch (error) { notice = error.message; } finally { busy = false; render(); }
  }
  async function loadGIS() {
    if (root.google?.accounts?.oauth2) return;
    if (!gisPromise) gisPromise = new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.onload = resolve; script.onerror = () => reject(new Error('Nie udało się załadować logowania Google.')); document.head.append(script); });
    return gisPromise;
  }
  async function identify() {
    const result = await transport.request('drive/v3/about?fields=user(permissionId,emailAddress,displayName)');
    if (!result.user?.permissionId) throw new Error('Nie udało się ustalić konta Google.'); return result.user;
  }
  async function receiveToken(response) {
    try {
      if (response.error || !response.access_token || !root.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) throw new Error('Nie przyznano dostępu do prywatnych danych aplikacji.');
      token = { accessToken: response.access_token, expiresAt: Date.now() + Number(response.expires_in) * 1000 - 30000 };
      const user = await identify();
      if (preferences.accountId && preferences.accountId !== user.permissionId && !root.confirm('Wybrano inne konto Google. Kontynuować?')) { token = null; clearSession(); return; }
      await initialize(user); saveSession(); notice = 'Połączono z Google Drive.'; render(); await synchronize();
    } catch (error) { token = null; account = null; clearSession(); notice = error.message; render(); }
  }
  function createEngine(accountId) {
    const device = root.localStorage.getItem('infomatyka-cloud-save-device') || root.crypto.randomUUID();
    root.localStorage.setItem('infomatyka-cloud-save-device', device);
    return new CloudSaveEngine({ storage: root.localStorage, store,
      boards: new BoardStore(root.indexedDB, root.crypto, () => root.dispatchEvent(new CustomEvent('infomatyka:data-changed', { detail: { dataset: 'boards' } }))),
      crypto: root.crypto, transport, account: accountId, device, deviceName: '' });
  }
  async function initialize(user) {
    account = user; preferences.accountId = user.permissionId; preferences.email = user.emailAddress || ''; savePrefs();
    engine = createEngine(user.permissionId);
  }
  function connect() { tokenClient?.requestAccessToken({ prompt: 'consent' }); }
  async function deleteCloudData() {
    if (!connected() || !engine || busy) return;
    const confirmed = root.confirm('Usunąć trwale wszystkie pliki InfoMatyki z ukrytego folderu danych tej aplikacji na Google Drive? Zostaną usunięte obecne zapisy schema 5, starsze zapisy schema 3 oraz pliki tablic. Dane lokalne i lokalna historia kopii pozostaną. Operacji nie można cofnąć.');
    if (!confirmed) return;
    busy = true; notice = 'Sprawdzanie danych aplikacji na Google Drive…'; render();
    let deletedCount = 0, totalCount = 0;
    const removeFiles = async () => {
      const files = await transport.listAppDataFiles();
      totalCount = files.length;
      for (let index = 0; index < files.length; index++) {
        await transport.deleteFile(files[index].id);
        deletedCount = index + 1;
        if ((index + 1) % 10 === 0 || index + 1 === files.length) {
          notice = 'Usuwanie danych z Google Drive: ' + (index + 1) + '/' + files.length + '…';
          render();
        }
      }
      await engine.clearRemoteBase();
      review = null; closeConflict();
      notice = files.length
        ? 'Usunięto dane aplikacji z Google Drive. Dane lokalne pozostały; kolejna synchronizacja utworzy nowy zapis.'
        : 'Na Google Drive nie było danych aplikacji do usunięcia. Dane lokalne pozostały.';
    };
    try {
      if (root.navigator.locks) await root.navigator.locks.request('infomatyka-cloud-save-v5', removeFiles);
      else await removeFiles();
    } catch (error) {
      notice = deletedCount && deletedCount < totalCount
        ? 'Usunięto część danych (' + deletedCount + '/' + totalCount + '). Ponów czyszczenie, aby usunąć resztę.'
        : error.message;
    }
    finally { busy = false; render(); }
  }
  function disconnect() {
    token = null; account = null; clearSession(); preferences.connectionActive = false; savePrefs();
    closeConflict(); notice = 'Odłączono Google Drive. Dane pozostają na tym urządzeniu.'; render();
  }
  function markDirty() {
    if (applying) return;
    if (!root.navigator.onLine) { notice = 'Offline. Zmiany zapisane lokalnie.'; render(); return; }
    if (!connected() || !engine) { notice = 'Zmiany zapisane lokalnie.'; render(); return; }
    clearTimeout(timer); timer = setTimeout(synchronize, 4000);
  }
  async function prepare() {
    loadPrefs();
    try {
      if (!root.localforage) throw new Error('Nie załadowano lokalnego magazynu danych.');
      store = root.localforage.createInstance({ name: DB_NAME, storeName: STORE_NAME });
      engine = createEngine('device-local');
      if (!config.clientId) { notice = 'Google Drive nie jest skonfigurowany. Dane pozostają lokalnie.'; render(); return; }
      if (!root.isSecureContext || !root.crypto?.subtle) throw new Error('Zapis w chmurze wymaga bezpiecznego połączenia.');
      await loadGIS();
      tokenClient = root.google.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope: SCOPE, include_granted_scopes: false, callback: receiveToken,
        error_callback: () => { notice = 'Okno Google zostało zamknięte lub zablokowane.'; render(); } });
      let saved = null; try { saved = JSON.parse(root.sessionStorage.getItem(SESSION_KEY)); } catch (_) {}
      if (preferences.connectionActive && saved?.clientId === config.clientId && saved.token?.expiresAt > Date.now()) {
        token = saved.token; const user = await identify();
        if (user.permissionId === saved.accountId) { await initialize(user); notice = 'Połączono z Google Drive.'; await synchronize(); }
        else { token = null; clearSession(); notice = 'Połącz ponownie z Google Drive.'; }
      } else if (preferences.connectionActive) notice = 'Połącz ponownie z Google Drive. Dane zapisują się lokalnie.';
    } catch (error) { notice = error.message; }
    render();
  }
  function install() {
    panel = document.getElementById('infomatyka-drive-settings');
    ensureConflictStyles();
    root.InfoMatykaCloudSave = { version: MODULE_VERSION, connect, disconnect, sync: synchronize, markDirty, deleteCloudData,
      getStatus: () => ({ connected: connected(), account: account?.emailAddress || '', message: notice, busy }),
      downloadBackup: downloadLocalBackup, openHistory: async () => { historyOpen = true; historyItems = engine ? await engine.listHistory() : []; render(); },
      resolveConflict, inspect: () => engine ? engine.inspect() : Promise.resolve(null),
      restoreHistory, guardBoardWrite: () => { if (applying) throw new Error('Poczekaj na zapis danych.'); } };
    root.addEventListener('infomatyka:data-changed', event => { if (!applying && event.detail?.dataset !== 'cloud-save-apply') markDirty(); });
    root.addEventListener('online', () => { if (connected()) synchronize(); });
    root.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && connected()) synchronize(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prepare, { once: true }); else prepare();
    render();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MODULE_VERSION, SAVE_SCHEMA, BOARD_SCHEMA, BOARD_DB_VERSION, MAX_SAVE_BYTES,
      CloudSaveEngine, DriveTransport, stable, byteSize, digest, validateSave, validateSnapshot,
      mergeSnapshots, makeBackup, zipStore, DATA_REGISTRY: DATA, MERGE_CORE: MERGE, validateBoards, validateAssetBlob, BoardStore };
    return;
  }
  if (root.addEventListener && root.document) install();
})(typeof globalThis === 'object' ? globalThis : this);
