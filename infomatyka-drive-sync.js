/* InfoMatyka: private, browser-only Google Drive synchronization (schema 1).
 * No secrets or OAuth tokens are persisted. Each device writes its own head.
 * Vector clocks detect simultaneous changes; conflicts require a user decision.
 */
(function (root) {
  'use strict';
  if (root.InfoMatykaDrive) return;
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const SETTINGS_KEY = 'infomatyka_drive_preferences_v1';
  const DEVICE_KEY = 'infomatyka_drive_device_v1';
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_FILES = 100;
  const BOARD_STORES = ['boards', 'boardIndex', 'folders', 'meta'];
  const CATEGORIES = {
    profile: { label: 'Profil i dostępność', keys: ['generator_profil_uzytkownika', 'infomatyka_accessibility'] },
    progress: { label: 'XP, odznaki i ustawienia grywalizacji', keys: ['infomatyka_postep_uzytkownika'] },
    learning: { label: 'Postęp w nauce', keys: ['infomatyka_postep_nauki'] },
    favorites: { label: 'Ulubione artykuły', keys: ['infomatyka_ulubione_artykuly'] },
    generator: { label: 'Generator: zestawy, zadania i materiały', keys: ['generator_zestawy_zadan', 'generator_szybkie_kartkowki', 'generator_baza_zadan', 'generator_wlasne_moduly', 'generator_skala_latex', 'generator_zapisane_materialy', 'generator_ignorowane_brakujace_zadania'], tasks: true },
    teacher: { label: 'Klasy, kalendarz i raporty testów', keys: ['infomatyka_teacher_data', 'generator_klasy_tablicy', 'generator_sesje_tablicy', 'generator_konfiguracja_raportow', 'generator_progi_ocen', 'generator_wybrane_rekomendacje', 'infomatyka_setup_settings'] },
    boards: { label: 'Tablice interaktywne, obrazy, foldery i powiązania z lekcjami', keys: ['wb3-palm-eraser', 'wb3-toolbar-layout'], boards: true }
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const byteSize = value => new TextEncoder().encode(stable(value)).length;
  function validateBoards(data) {
    if (!object(data) || Object.keys(data).length !== BOARD_STORES.length || BOARD_STORES.some(name =>
      !Array.isArray(data[name]) || data[name].some(row => !object(row) || typeof row.id !== 'string' || !row.id) ||
      new Set(data[name].map(row => row.id)).size !== data[name].length)) throw new Error('Nieprawidłowa kopia biblioteki tablic.');
    const index = new Map(data.boardIndex.map(row => [row.id, row]));
    if (data.boards.some(row => !object(row.project) || !Array.isArray(row.project.pages) ||
      !index.has(row.id) || index.get(row.id).deletedAt) ||
      data.boardIndex.some(row => typeof row.name !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        (!row.deletedAt && !data.boards.some(board => board.id === row.id))) ||
      data.folders.some(row => typeof row.name !== 'string')) throw new Error('Kopia tablic jest niekompletna lub uszkodzona.');
  }
  // Projects contain their image data URLs; preserve entire records, including tombstones.
  class BoardStore {
    constructor(indexedDB, onChanged) { this.indexedDB = indexedDB; this.onChanged = onChanged; }
    async open() {
      if (!this.indexedDB) throw new Error('Przeglądarka nie udostępnia bazy tablic (IndexedDB).');
      return new Promise((resolve, reject) => {
        const request = this.indexedDB.open('infomatyka_tablice_interaktywne', 1); let blocked = false;
        request.onupgradeneeded = () => BOARD_STORES.forEach(name => request.result.createObjectStore(name, { keyPath: 'id' }));
        request.onerror = () => reject(request.error);
        request.onblocked = () => { blocked = true; reject(new Error('Zamknij inne karty tablic i spróbuj ponownie.')); };
        request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
      });
    }
    async transaction(mode, incoming, expected) {
      if (incoming) validateBoards(incoming);
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORES, mode), snapshot = {}; let remaining = BOARD_STORES.length, reason;
        tx.oncomplete = () => { db.close(); if (incoming && this.onChanged) this.onChanged(); resolve(snapshot); };
        tx.onerror = tx.onabort = () => { db.close(); reject(reason || tx.error || new Error('Nie udało się zapisać biblioteki tablic.')); };
        BOARD_STORES.forEach(name => {
          const store = tx.objectStore(name);
          store.getAll().onsuccess = event => {
            snapshot[name] = event.target.result.sort((a, b) => a.id.localeCompare(b.id));
            if (--remaining || !incoming) return;
            // Compare and replace in one IDB transaction, also against writes from the board page.
            if (stable(snapshot) !== stable(expected)) {
              reason = new Error('Tablice zmieniły się w innej karcie. Porównaj wersje ponownie.'); tx.abort(); return;
            }
            try {
              BOARD_STORES.forEach(key => { const target = tx.objectStore(key); target.clear(); incoming[key].forEach(row => target.put(row)); });
            } catch (error) { reason = error; tx.abort(); }
          };
        });
      });
    }
    capture() { return this.transaction('readonly'); }
    replace(incoming, expected) { return this.transaction('readwrite', incoming, expected); }
  }
  async function digest(value, cryptoAPI, enforceLimit = true) {
    const bytes = new TextEncoder().encode(stable(value));
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
    return records.filter(a => !records.some(b => dominates(b.vector, a.vector)));
  }
  function empty(data) { return Object.values(data.local).every(v => v === null) && (!has(data, 'tasks') || data.tasks === null) &&
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
    if (!object(record) || record.app !== 'InfoMatyka' || record.schema !== 1 || record.category !== category || !spec ||
        !/^[a-zA-Z0-9-]{8,80}$/.test(record.device || '') || !object(record.vector) ||
        !Number.isSafeInteger(record.vector[record.device]) || record.vector[record.device] < 1 ||
        Object.keys(record.vector).length > 100 || Object.entries(record.vector).some(([k, v]) => !/^[a-zA-Z0-9-]{8,80}$/.test(k) || !Number.isSafeInteger(v) || v < 1) ||
        !object(record.data) || !object(record.data.local) || !/^[a-f0-9]{64}$/.test(record.hash || '')) {
      throw new Error('Nieobsługiwany lub uszkodzony zapis Drive. Dane lokalne pozostają zachowane.');
    }
    if (Object.keys(record.data).some(k => !['local', 'tasks', 'boards'].includes(k)) ||
        Object.keys(record.data.local).length !== spec.keys.length ||
        spec.keys.some(k => !has(record.data.local, k) || (record.data.local[k] !== null && typeof record.data.local[k] !== 'string')) ||
        Object.keys(record.data.local).some(k => !spec.keys.includes(k)) ||
        (spec.tasks ? !has(record.data, 'tasks') : has(record.data, 'tasks')) ||
        (spec.boards ? !has(record.data, 'boards') : has(record.data, 'boards'))) throw new Error('Zapis zawiera nieprawidłowy zakres danych.');
    if (spec.boards) validateBoards(record.data.boards);
    return record;
  }

  class DriveTransport {
    constructor(fetcher, token, onUnauthorized) { this.fetcher = fetcher; this.token = token; this.onUnauthorized = onUnauthorized; }
    async request(path, options = {}) {
      const auth = this.token();
      if (!auth || Date.now() >= auth.expiresAt) throw new Error('Połączenie wygasło. Kliknij „Połącz z Google Drive”.');
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
          response = await this.fetcher('https://www.googleapis.com/' + path, { ...options, signal: controller.signal,
            headers: { ...options.headers, Authorization: 'Bearer ' + auth.accessToken } });
        } finally { clearTimeout(timer); }
        if (!(response.status === 429 || response.status >= 500) || options.method === 'POST') break;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 300));
      }
      if (!response.ok) {
        if (response.status === 401) { if (this.onUnauthorized) this.onUnauthorized(); throw new Error('Google cofnęło lub zakończyło dostęp. Połącz ponownie.'); }
        if (response.status === 403) throw new Error('Google odmówiło dostępu. Sprawdź zgodę, Drive API, limit i zasady konta szkolnego.');
        if (response.status === 429 || response.status >= 500) throw new Error('Google Drive jest chwilowo niedostępny. Spróbuj później.');
        throw new Error('Nie udało się odczytać lub zapisać danych Drive (HTTP ' + response.status + ').');
      }
      const content = await response.text();
      if (new TextEncoder().encode(content).length > MAX_BYTES + 100000) throw new Error('Zapis Drive jest zbyt duży.');
      return content ? JSON.parse(content) : null;
    }
    async list(category) {
      const files = []; let page;
      do {
        const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '100',
          fields: 'nextPageToken,files(id,name,size,modifiedTime,appProperties)',
          q: "trashed = false and appProperties has { key='imSync' and value='v1' } and appProperties has { key='category' and value='" + category + "' }" });
        if (page) params.set('pageToken', page);
        const result = await this.request('drive/v3/files?' + params);
        files.push(...(result.files || [])); page = result.nextPageToken;
        if (files.length > MAX_FILES) throw new Error('Przekroczono limit 100 plików urządzeń w kategorii. Synchronizacja zatrzymana.');
      } while (page);
      return files;
    }
    async read(file) { return this.request('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media'); }
    async write(record, ownFiles) {
      const content = stable(record);
      if (new TextEncoder().encode(content).length > MAX_BYTES) throw new Error('Zapis przekracza 8 MiB.');
      if (ownFiles.length) {
        // Never overwrite another device's head. Web Locks serialize this device's tabs.
        await this.request('upload/drive/v3/files/' + encodeURIComponent(ownFiles[0].id) + '?uploadType=media', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content });
        return;
      }
      const boundary = 'im_' + record.device;
      const metadata = { name: 'infomatyka-v1-' + record.category + '-' + record.device + '.json',
        mimeType: 'application/json', parents: ['appDataFolder'],
        appProperties: { imSync: 'v1', category: record.category, device: record.device } };
      const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--' + boundary + '--';
      // No automatic POST retry: if the response is lost, the next sync re-lists files.
      await this.request('upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    }
  }

  class SyncEngine {
    constructor(options) { Object.assign(this, options); }
    checkpointKey(category) { return 'infomatyka_drive_base_v1_' + this.account + '_' + category; }
    async capture(category) {
      const data = { local: Object.create(null) }, spec = CATEGORIES[category];
      spec.keys.forEach(k => { data.local[k] = this.storage.getItem(k); });
      if (spec.tasks) {
        if (!this.tasks) throw new Error('Nie załadowano pamięci zadań. Odśwież ustawienia i spróbuj ponownie.');
        data.tasks = await this.tasks.getItem('generator_baza_zadan');
        // localForage is canonical; localStorage is the existing generator's fallback.
        if (data.tasks === null && data.local.generator_baza_zadan !== null) data.tasks = JSON.parse(data.local.generator_baza_zadan);
        data.local.generator_baza_zadan = null;
      }
      if (spec.boards) {
        if (!this.boards) throw new Error('Nie załadowano pamięci tablic.');
        data.boards = await this.boards.capture();
      }
      return data;
    }
    // Oversized local data can still be compared/backed up and replaced by a smaller cloud copy.
    async hash(data) { return digest(data, this.crypto, false); }
    async backup(category, data) {
      const key = this.account + ':' + category;
      const copies = await this.backups.getItem(key) || [];
      const copy = { at: new Date().toISOString(), category, data };
      await this.backups.setItem(key, [copy, ...copies].slice(0, 5));
    }
    async apply(category, incoming, before) {
      // Fail closed if a durable rollback copy cannot be stored (e.g. quota full).
      await this.backup(category, before);
      if (await this.hash(await this.capture(category)) !== await this.hash(before)) throw new Error('Dane zmieniły się podczas pobierania. Spróbuj ponownie.');
      const spec = CATEGORIES[category];
      const writeLocal = data => spec.keys.forEach(k => {
        const v = data.local[k]; if (v === null) this.storage.removeItem(k); else this.storage.setItem(k, v);
      });
      try {
        // Synchronous localStorage part cannot interleave within this tab.
        writeLocal(incoming);
        if (spec.tasks) {
          if (incoming.tasks === null) await this.tasks.removeItem('generator_baza_zadan');
          else await this.tasks.setItem('generator_baza_zadan', incoming.tasks);
        }
        if (spec.boards) await this.boards.replace(incoming.boards, before.boards);
      } catch (error) {
        try {
          writeLocal(before);
          if (spec.tasks) {
            if (before.tasks === null) await this.tasks.removeItem('generator_baza_zadan');
            else await this.tasks.setItem('generator_baza_zadan', before.tasks);
          }
        } catch (_) { throw new Error('Pamięć urządzenia jest pełna. Kopia sprzed zmiany pozostaje w „Pobierz kopie lokalne”.'); }
        throw error;
      }
      if (this.onApplied) this.onApplied(category);
    }
    async inspect(category) {
      const local = await this.capture(category), localHash = await this.hash(local);
      const files = await this.transport.list(category), records = [];
      for (const file of files) {
        const record = validateRecord(await this.transport.read(file), category);
        if (file.appProperties.device !== record.device || record.hash !== await this.hash(record.data)) throw new Error('Zapis Drive nie przeszedł kontroli integralności.');
        records.push({ ...record, fileId: file.id, bytes: byteSize(record.data), fileBytes: Number(file.size) || byteSize(record), savedAt: file.modifiedTime || record.updatedAt });
      }
      const cloud = heads(records);
      const signature = stable(cloud.map(r => ({ id: r.fileId, hash: r.hash, vector: r.vector })).sort((a, b) => a.id.localeCompare(b.id)));
      let base = null;
      try { base = JSON.parse(this.storage.getItem(this.checkpointKey(category))); } catch (_) { /* recover with a conflict */ }
      const action = decide(localHash, cloud, base, empty(local));
      const observedKey = 'infomatyka_drive_observed_v1_' + category;
      let observed; try { observed = JSON.parse(this.storage.getItem(observedKey)); } catch (_) { }
      // Older localStorage modules do not record save times: label this as observation, never invent a save date.
      if (!observed || observed.hash !== localHash) {
        observed = { hash: localHash, at: new Date().toISOString() }; this.storage.setItem(observedKey, JSON.stringify(observed));
      }
      const dates = local.boards ? local.boards.boardIndex.flatMap(row => [row.updatedAt, row.deletedAt, row.createdAt]).filter(value => Number.isFinite(value) && value > 0) : [];
      const savedAt = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
      const vector = mergeClocks([...cloud.map(r => r.vector), ...(base && object(base.vector) ? [base.vector] : [])]);
      vector[this.device] = (vector[this.device] || 0) + 1;
      const uploadBytes = byteSize({ app: 'InfoMatyka', schema: 1, category, device: this.device,
        updatedAt: new Date().toISOString(), vector, hash: localHash, data: local });
      return { category, action, local, localHash, signature, cloud, files, base, fileCount: files.length,
        localVersion: { bytes: byteSize(local), uploadBytes, savedAt, observedAt: observed.at, empty: empty(local) } };
    }
    async sync(category, resolution) {
      const review = await this.inspect(category);
      const { local, localHash, files, cloud, signature, base } = review;
      let action = review.action;
      let chosen;
      // A decision applies only to the versions the user actually reviewed.
      if (resolution && (resolution.signature !== signature || resolution.localHash !== localHash)) action = 'conflict';
      if (resolution && resolution.signature === signature && resolution.localHash === localHash) {
        if (resolution.source === 'local') action = 'push';
        else { chosen = cloud.find(r => r.fileId === resolution.source); action = chosen ? 'resolve' : 'conflict'; }
      }
      if (action === 'conflict') return { ...review, action };
      if (action === 'none') return { category, action };
      const ownFiles = files.filter(f => f.appProperties.device === this.device);
      if ((action === 'push' || action === 'resolve') && !ownFiles.length && files.length >= MAX_FILES) throw new Error('Osiągnięto limit 100 plików urządzeń. Nowe urządzenie nie może dodać zapisu w tej kategorii.');
      if (await this.hash(await this.capture(category)) !== localHash) throw new Error('Dane lokalne zmieniły się w trakcie synchronizacji. Spróbuj ponownie.');
      const vector = mergeClocks([...cloud.map(r => r.vector), ...(base && object(base.vector) ? [base.vector] : [])]);
      chosen = chosen || cloud[0];
      const nextHash = action === 'pull' || action === 'resolve' ? chosen.hash : localHash;
      let record;
      if (action === 'push' || action === 'resolve') {
        vector[this.device] = (vector[this.device] || 0) + 1;
        record = { app: 'InfoMatyka', schema: 1, category, device: this.device,
          updatedAt: new Date().toISOString(), vector, hash: nextHash, data: action === 'resolve' ? chosen.data : local };
        validateRecord(record, category);
        if (byteSize(record) > MAX_BYTES) throw new Error('Zapis wraz z opisem przekracza limit 8 MiB. Zmniejsz dane lub załączniki.');
      }
      if (resolution && (action === 'push' || action === 'resolve')) {
        for (const record of cloud) await this.backup(category, record.data);
        if (action === 'push') await this.backup(category, local);
      }
      if (action === 'pull' || action === 'resolve') {
        await this.apply(category, chosen.data, local);
      }
      if (action === 'push' || action === 'resolve') {
        await this.transport.write(record, ownFiles);
      }
      this.storage.setItem(this.checkpointKey(category), JSON.stringify({ hash: nextHash, vector }));
      return { category, action };
    }
  }
  // Export the actual engine for deterministic integration tests, without initializing browser UI.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CATEGORIES, SyncEngine, BoardStore, DriveTransport, MAX_BYTES, MAX_FILES, byteSize, stable, digest, dominates, mergeClocks, heads, decide, validateRecord }; return;
  }

  let token = null, account = null, ready = false, busy = false, authorizing = false, client = null, gisPromise = null;
  let engine, backupStore, pending = [], comparisons = [], recovery = [], panel, notice = '', applied = false;
  let prefs = { selected: [], automatic: false, boundAccount: '', lastSync: '' };
  try { prefs = { ...prefs, ...JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { }
  prefs.selected = Array.isArray(prefs.selected) ? prefs.selected.filter(k => has(CATEGORIES, k)) : [];
  const config = root.InfoMatykaDriveConfig || {};
  const configured = typeof config.clientId === 'string' && /^[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId);
  const connected = () => !!token && Date.now() < token.expiresAt && !!account;
  function savePrefs() { root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); }
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
  const transport = new DriveTransport(root.fetch.bind(root), () => token, () => { token = null; });
  function disconnect() { token = null; account = null; pending = []; comparisons = []; recovery = []; notice = 'Odłączono na tym urządzeniu. Dane na Drive pozostają zachowane.'; render(); }
  async function receiveToken(response) {
    try {
      if (response.error || !response.access_token || !root.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) throw new Error('Nie przyznano dostępu do danych aplikacji na Drive.');
      token = { accessToken: response.access_token, expiresAt: Date.now() + Number(response.expires_in || 0) * 1000 - 30000 };
      const about = await transport.request('drive/v3/about?fields=user(permissionId,emailAddress,displayName)');
      if (!about.user || !about.user.permissionId) throw new Error('Nie udało się ustalić właściciela Dysku.');
      const user = about.user;
      if (prefs.boundAccount && prefs.boundAccount !== user.permissionId) {
        if (!root.confirm('Wybrano inne konto Google: ' + (user.emailAddress || user.displayName) + '. Dane w tej przeglądarce mogą należeć do poprzedniego użytkownika. Po kontynuacji będzie można synchronizować je z nowym kontem. Kontynuować?')) { disconnect(); return; }
        prefs.automatic = false;
      }
      account = user; pending = []; comparisons = []; prefs.automatic = false; prefs.boundAccount = user.permissionId; savePrefs();
      const device = root.localStorage.getItem(DEVICE_KEY) || root.crypto.randomUUID();
      root.localStorage.setItem(DEVICE_KEY, device);
      backupStore = root.localforage.createInstance({ name: 'infomatyka_drive_recovery', storeName: 'copies' });
      engine = new SyncEngine({ storage: root.localStorage, tasks: root.localforage, backups: backupStore,
        boards: new BoardStore(root.indexedDB, () => {
          root.dispatchEvent(new Event('infomatyka-boards-changed'));
          if (root.BroadcastChannel) { const channel = new root.BroadcastChannel('infomatyka_tablice_interaktywne'); channel.postMessage('changed'); channel.close(); }
        }),
        crypto: root.crypto, transport, device, account: user.permissionId,
        onApplied: () => { applied = true; root.dispatchEvent(new Event('infomatyka_progress_updated')); root.dispatchEvent(new Event('infomatyka_drive_applied')); } });
      notice = 'Połączono. Wybierz kategorie, porównaj wersje i zdecyduj, którą zachować. Samo porównanie nie nadpisuje danych.'; render();
    } catch (e) { token = null; account = null; notice = e.message; }
    finally { authorizing = false; render(); }
    if (connected() && prefs.selected.length) await synchronize();
  }
  async function prepare() {
    if (!configured) { render(); return; }
    try {
      if (!root.isSecureContext || !root.crypto.subtle) throw new Error('Synchronizacja wymaga HTTPS lub localhost.');
      if (!root.navigator.locks) throw new Error('Ta przeglądarka nie obsługuje bezpiecznej synchronizacji wielu kart (Web Locks). Użyj aktualnej przeglądarki.');
      if (!root.localforage) throw new Error('Nie załadowano localForage. Odśwież stronę.');
      await loadGIS();
      client = root.google.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope: SCOPE,
        include_granted_scopes: false, callback: receiveToken,
        error_callback: () => { authorizing = false; notice = 'Okno Google zostało zamknięte lub zablokowane. Kliknij „Połącz” ponownie.'; render(); } });
      ready = true; render();
    } catch (e) { notice = e.message; render(); }
  }
  async function synchronize(resolution, automatic = false) {
    if (busy || !connected() || !engine || !prefs.selected.length) return;
    busy = true; notice = !automatic && !resolution ? 'Odczytywanie wersji lokalnych i Google Drive…' : 'Synchronizowanie wybranych kategorii…'; render();
    const selected = resolution ? [resolution.category] : [...prefs.selected];
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        // Preferences and checkpoints may have changed while waiting for another tab.
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
        if (latest.boundAccount !== account.permissionId) throw new Error('Konto Drive zmieniło się w innej karcie. Połącz ponownie.');
        if (automatic && !latest.automatic) return;
        if (!resolution) { pending = []; comparisons = []; }
        const errors = [];
        for (const category of selected.filter(k => (latest.selected || []).includes(k))) {
          try {
            const result = !automatic && !resolution ? await engine.inspect(category) : await engine.sync(category, resolution);
            const comparison = !automatic && !resolution || result.action === 'conflict' ? result : await engine.inspect(category);
            comparisons = [...comparisons.filter(p => p.category !== category), comparison];
            pending = pending.filter(p => p.category !== category);
            if (comparison.action !== 'same' && comparison.action !== 'none') pending.push(comparison);
          } catch (error) {
            comparisons = [...comparisons.filter(p => p.category !== category), { category, error: error.message }];
            pending = pending.filter(p => p.category !== category); errors.push(CATEGORIES[category].label + ': ' + error.message);
          }
        }
        // Preserve settings changed by another tab during the network calls.
        prefs = { ...prefs, ...JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}'), lastSync: new Date().toISOString() };
        if (errors.length || pending.length) prefs.automatic = false;
        savePrefs();
        notice = errors.length ? errors.join(' ') : pending.length ? 'Porównaj daty i rozmiary. Wybierz wersję osobno dla każdej kategorii; wybór może nadpisać drugą wersję.' : 'Wybrane dane są zgodne. Nie trzeba niczego nadpisywać.';
      });
    } catch (e) { notice = e.message; }
    finally { busy = false; render(); }
  }
  async function downloadRecovery() {
    try {
      const items = [];
      const store = backupStore || root.localforage.createInstance({ name: 'infomatyka_drive_recovery', storeName: 'copies' });
      await store.iterate((copies, key) => { items.push({ key, copies }); });
      const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'InfoMatyka', recoverySchema: 1, items }, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'infomatyka-kopie-przed-synchronizacja.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { notice = e.message; render(); }
  }
  async function showRecovery() {
    try {
      recovery = [];
      for (const category of Object.keys(CATEGORIES)) {
        const copies = await backupStore.getItem(account.permissionId + ':' + category) || [];
        recovery.push(...copies);
      }
      notice = recovery.length ? 'Wybierz kopię do przywrócenia na tym urządzeniu.' : 'Nie ma jeszcze kopii sprzed synchronizacji dla tego konta.';
    } catch (e) { notice = e.message; }
    render();
  }
  async function restoreCopy(copy) {
    if (!connected() || busy || !root.confirm('Przywrócić lokalnie całą kategorię „' + CATEGORIES[copy.category].label + '” z ' + copy.at + '? Automatyczna synchronizacja zostanie wyłączona.')) return;
    busy = true; prefs.automatic = false; savePrefs(); render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        const current = await engine.capture(copy.category);
        await engine.apply(copy.category, copy.data, current);
      });
      recovery = []; pending = []; comparisons = []; notice = 'Przywrócono kopię lokalną. Odśwież widok. Drive zmieni się dopiero po kolejnej synchronizacji.';
    } catch (e) { notice = e.message; }
    finally { busy = false; render(); }
  }
  function beginConnect() {
    // Disable data transfer until Google has identified the newly selected account.
    token = null; account = null; engine = null; pending = []; comparisons = []; recovery = []; authorizing = true;
    notice = 'Wybierz konto w oknie Google.'; render();
    client.requestAccessToken({ prompt: 'select_account' });
  }
  function button(label, action, disabled = false) {
    const b = text('button', label, 'im-drive-button'); b.type = 'button'; b.disabled = disabled || busy || authorizing; b.addEventListener('click', action); return b;
  }
  function formatBytes(bytes) {
    return bytes < 1024 ? bytes + ' B' : (bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString('pl-PL', { maximumFractionDigits: 2 }) + (bytes < 1024 * 1024 ? ' KiB' : ' MiB');
  }
  function formatDate(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pl-PL') : 'Data zapisu nieznana'; }
  function canAutomate() { return prefs.selected.length && prefs.selected.every(category => comparisons.some(p => p.category === category && ['same', 'none'].includes(p.action))); }
  function renderComparison(comparison) {
    const box = text('section', '', 'im-drive-comparison');
    box.append(text('h4', CATEGORIES[comparison.category].label));
    if (comparison.error) { box.append(text('p', comparison.error, 'im-drive-status')); return box; }
    const { localVersion, cloud } = comparison;
    box.append(text('p', 'Pliki urządzeń w tej kategorii: ' + comparison.fileCount + ' / 100. Limit zapisu: 8 MiB na kategorię.', 'im-drive-help'));
    const versions = text('div', '', 'im-drive-versions');
    const resolve = source => {
      const message = source === 'local' ? 'Wersja lokalna zastąpi bieżącą wersję tej kategorii na Google Drive. Inne urządzenia będą mogły ją pobrać.' : 'Wybrana wersja Google Drive zastąpi wszystkie lokalne dane tej kategorii. Zostanie też wskazana jako wersja do synchronizacji na innych urządzeniach.';
      if (root.confirm(message + '\n\nKategoria: ' + CATEGORIES[comparison.category].label + '. Przed zmianą zachowamy lokalne kopie. Kontynuować?')) synchronize({ ...comparison, source });
    };
    const localCard = text('div', '', 'im-drive-version'); localCard.append(text('h5', 'Wersja lokalna · to urządzenie'));
    localCard.append(text('p', localVersion.empty ? 'Brak zapisanych danych.' : (localVersion.savedAt ? 'Ostatni zapis tablicy: ' + formatDate(localVersion.savedAt) : 'Data wcześniejszego zapisu nie jest dostępna.')),
      text('p', 'Ten stan wykryto: ' + formatDate(localVersion.observedAt)), text('p', 'Rozmiar danych: ' + formatBytes(localVersion.bytes)));
    localCard.append(text('p', 'Rozmiar zapisu na Drive: ' + formatBytes(localVersion.uploadBytes) + ' / 8 MiB', 'im-drive-help'));
    if (localVersion.uploadBytes > MAX_BYTES) localCard.append(text('p', 'Lokalny zapis przekracza limit 8 MiB. Zmniejsz dane lub załączniki; możesz też wybrać mniejszą kopię Drive.', 'im-drive-status'));
    if (!['same', 'none'].includes(comparison.action)) localCard.append(button('Użyj lokalnej → zapisz na Drive', () => resolve('local'), localVersion.uploadBytes > MAX_BYTES));
    versions.append(localCard);
    if (!cloud.length) { const card = text('div', '', 'im-drive-version'); card.append(text('h5', 'Wersja Google Drive'), text('p', 'Brak kopii w chmurze.'), text('p', 'Rozmiar: 0 B')); versions.append(card); }
    cloud.forEach(record => {
      const card = text('div', '', 'im-drive-version');
      card.append(text('h5', 'Wersja Google Drive'), text('p', 'Zapis na Drive: ' + formatDate(record.savedAt)),
        text('p', 'Rozmiar danych: ' + formatBytes(record.bytes) + ' · plik: ' + formatBytes(record.fileBytes)),
        text('p', 'Urządzenie: ' + record.device.slice(0, 8), 'im-drive-help'));
      if (!['same', 'none'].includes(comparison.action)) card.append(button('Użyj Drive → pobierz na urządzenie', () => resolve(record.fileId)));
      versions.append(card);
    });
    box.append(versions, text('p', ['same', 'none'].includes(comparison.action) ? 'Wersje są zgodne; nadpisanie nie jest potrzebne.' :
      'Wybór dotyczy całej kategorii i może nadpisać drugą wersję. Dane nie są automatycznie łączone. Przed zmianą zachowamy kopie lokalne.', 'im-drive-help'));
    return box;
  }
  function render() {
    if (!panel) return;
    panel.replaceChildren();
    panel.append(text('h3', 'Synchronizacja z Google Drive'));
    panel.append(text('p', 'InfoMatyka może zapisywać i synchronizować wybrane dane w prywatnym folderze danych aplikacji na Twoim Google Drive. Odczytuje i zapisuje wyłącznie własne dane aplikacji; nie ma dostępu do Twoich zwykłych dokumentów. Kopie zajmują miejsce na Twoim koncie Google.'));
    panel.append(text('p', 'Możesz przenosić profil, postępy, ulubione, generator, klasy i kalendarz oraz tablice interaktywne z obrazami, folderami i powiązaniami z lekcjami. Najpierw zaloguj się do Google Drive, potem wybierz, co synchronizować.'));
    panel.append(text('p', 'Limity modułu: 8 MiB na zapis kategorii (łącznie z załącznikami i opisem zapisu), 100 plików urządzeń w kategorii i 5 lokalnych kopii przed zmianami na kategorię i konto. Drive przechowuje bieżące wersje urządzeń, bez nieograniczonej historii. Są to limity InfoMatyki, nie Google Drive. Kopie lokalne wymagają miejsca na urządzeniu.', 'im-drive-help'));
    panel.append(text('p', configured ? (connected() ? 'Połączono: ' + (account.emailAddress || account.displayName) : 'Połączenie wymaga kliknięcia przycisku. Dane lokalne są dostępne także offline.') : 'Połączenie nie jest jeszcze skonfigurowane przez administratora strony (brak Google OAuth Client ID).', 'im-drive-status'));
    const login = text('div', '', 'im-drive-actions');
    login.append(button(connected() ? 'Zaloguj ponownie / zmień konto Google' : 'Zaloguj się do Google Drive', beginConnect, !ready)); panel.append(login);
    if (!connected()) {
      const status = text('p', notice, 'im-drive-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
      return;
    }
    const choices = document.createElement('fieldset'); choices.disabled = busy || authorizing;
    choices.append(text('legend', 'Co chcesz synchronizować na tym urządzeniu?'));
    Object.entries(CATEGORIES).forEach(([key, spec]) => {
      const label = text('label', '', 'im-drive-choice'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = prefs.selected.includes(key);
      check.addEventListener('change', () => {
        prefs.selected = check.checked ? [...prefs.selected, key] : prefs.selected.filter(k => k !== key);
        prefs.automatic = false; pending = pending.filter(p => prefs.selected.includes(p.category)); comparisons = comparisons.filter(p => prefs.selected.includes(p.category)); savePrefs(); render();
        if (prefs.selected.length) synchronize();
      });
      label.append(check, text('span', spec.label)); choices.append(label);
    });
    panel.append(choices);
    panel.append(text('p', 'Odznaczenie zatrzymuje synchronizację kategorii na tym urządzeniu; nie usuwa kopii z Drive. Aby przenieść lekcje razem z tablicami, wybierz zarówno klasy i kalendarz, jak i tablice. Hasła i aktywne sesje logowania nie są synchronizowane.', 'im-drive-help'));
    const auto = text('label', '', 'im-drive-choice'); const autoCheck = document.createElement('input'); autoCheck.type = 'checkbox'; autoCheck.checked = !!prefs.automatic; autoCheck.disabled = busy || !canAutomate();
    autoCheck.addEventListener('change', () => { prefs.automatic = autoCheck.checked; savePrefs(); });
    auto.append(autoCheck, text('span', 'Synchronizuj automatycznie co 60 sekund, gdy te ustawienia są otwarte i połączenie jest aktywne.')); panel.append(auto);
    if (!canAutomate()) panel.append(text('p', 'Automatyczną synchronizację możesz włączyć po porównaniu i uzgodnieniu wersji wybranych kategorii.', 'im-drive-help'));
    panel.append(text('p', 'Po odświeżeniu, przejściu na inną podstronę lub wygaśnięciu zgody połącz Drive ponownie. Synchronizacja nie działa przy zamkniętej stronie.', 'im-drive-help'));
    const actions = text('div', '', 'im-drive-actions');
    actions.append(button('Porównaj wersje lokalne i Drive', () => synchronize(), !prefs.selected.length), button('Odłącz na tym urządzeniu', disconnect),
      button('Pokaż kopie do przywrócenia', showRecovery, !connected()), button('Pobierz kopie lokalne', downloadRecovery, !root.localforage));
    panel.append(actions);
    if (applied) panel.append(button('Odśwież widok po pobraniu danych', () => root.location.reload()));
    if (prefs.lastSync) panel.append(text('p', 'Ostatnie zakończone sprawdzenie: ' + formatDate(prefs.lastSync), 'im-drive-help'));
    const status = text('p', notice, 'im-drive-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
    if (recovery.length) {
      const copies = text('div', '', 'im-drive-conflict'); copies.append(text('h4', 'Lokalne kopie przed zmianami'));
      recovery.forEach(copy => copies.append(button('Przywróć: ' + CATEGORIES[copy.category].label + ' · ' + formatDate(copy.at) + ' · ' + formatBytes(byteSize(copy.data)), () => restoreCopy(copy))));
      panel.append(copies);
    }
    comparisons.filter(p => prefs.selected.includes(p.category)).forEach(comparison => panel.append(renderComparison(comparison)));
  }
  root.InfoMatykaDrive = { categories: CATEGORIES, synchronize, disconnect, mount: async function (element) {
    panel = element; render(); await prepare();
  } };
  root.addEventListener('storage', event => {
    if (event.key === SETTINGS_KEY || event.key === null) {
      try { const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY)); if (!latest || (account && latest.boundAccount !== account.permissionId)) disconnect(); prefs = latest || { selected: [], automatic: false, boundAccount: '' }; render(); } catch (_) { disconnect(); }
    }
  });
  setInterval(() => {
    if (panel && prefs.automatic && canAutomate() && document.visibilityState === 'visible' && connected() && !pending.length) synchronize(null, true);
    else if (panel && token && !connected()) { token = null; notice = 'Połączenie wygasło. Połącz Drive ponownie, aby wznowić synchronizację.'; render(); }
  }, 60000);
  function mountSettings() { const target = document.getElementById('infomatyka-drive-settings'); if (target) root.InfoMatykaDrive.mount(target); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSettings); else mountSettings();
})(typeof window !== 'undefined' ? window : globalThis);
