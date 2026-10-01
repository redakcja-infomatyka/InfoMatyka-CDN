/* InfoMatyka: private, browser-only Google Drive synchronization (schema 1).
 * OAuth access survives navigation in tab-scoped sessionStorage until Google expiry.
 * Each device writes its own head; no client secrets or refresh tokens are used.
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
        if (resolution.source === 'local') action = resolution.downloadOnly ? 'conflict' : 'push';
        else {
          chosen = cloud.find(r => r.fileId === resolution.source);
          action = chosen ? (resolution.downloadOnly && review.action === 'pull' ? 'pull' : resolution.downloadOnly ? 'conflict' : 'resolve') : 'conflict';
        }
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

  const SESSION_KEY = 'infomatyka_drive_session_v1';
  const GROUPS = [
    { label: 'Konto i postępy', detail: 'Profil, dostępność, XP, odznaki, nauka i ulubione', categories: ['profile', 'progress', 'learning', 'favorites'] },
    { label: 'Generator', detail: 'Zestawy, zadania i zapisane materiały', categories: ['generator'] },
    { label: 'Klasy i kalendarz', detail: 'Uczniowie, lekcje, oceny i raporty', categories: ['teacher'] },
    { label: 'Tablice interaktywne', detail: 'Tablice, obrazy, foldery i powiązania', categories: ['boards'] }
  ];
  let token = null, account = null, ready = false, busy = false, authorizing = false, client = null, gisPromise = null;
  let engine, backupStore, comparisons = [], recovery = [], panel, notice = '', applied = false, afterAuth = null;
  let cloudChoices = Object.create(null);
  let prefs = { selected: Object.keys(CATEGORIES), selectionVersion: 2, fetchLatest: false, automatic: false, boundAccount: '', accountEmail: '', lastSync: '' };
  try {
    const stored = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
    prefs = { ...prefs, ...stored, automatic: false };
    if (stored.selectionVersion !== 2) prefs.selected = Object.keys(CATEGORIES);
    prefs.selectionVersion = 2;
  } catch (_) { }
  prefs.selected = Array.isArray(prefs.selected) ? prefs.selected.filter(k => has(CATEGORIES, k)) : Object.keys(CATEGORIES);
  const config = root.InfoMatykaDriveConfig || {};
  const configured = typeof config.clientId === 'string' && /^[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId);
  const connected = () => !!token && Date.now() < token.expiresAt && !!account;
  function savePrefs() { root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); }
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
  function disconnect() {
    token = null; account = null; engine = null; comparisons = []; recovery = []; afterAuth = null;
    prefs.automatic = false; savePrefs(); clearSession();
    notice = 'Odłączono na tym urządzeniu. Dane na Drive pozostają zachowane.'; render();
  }
  function initializeAccount(user) {
    account = user; comparisons = []; recovery = []; cloudChoices = Object.create(null);
    prefs.boundAccount = user.permissionId; prefs.accountEmail = user.emailAddress || ''; savePrefs(); saveSession();
    const device = root.localStorage.getItem(DEVICE_KEY) || root.crypto.randomUUID();
    root.localStorage.setItem(DEVICE_KEY, device);
    backupStore = root.localforage.createInstance({ name: 'infomatyka_drive_recovery', storeName: 'copies' });
    engine = new SyncEngine({ storage: root.localStorage, tasks: root.localforage, backups: backupStore,
      boards: new BoardStore(root.indexedDB, () => {
        root.dispatchEvent(new Event('infomatyka-boards-changed'));
        if (root.BroadcastChannel) { const channel = new root.BroadcastChannel('infomatyka_tablice_interaktywne'); channel.postMessage('changed'); channel.close(); }
      }), crypto: root.crypto, transport, device, account: user.permissionId,
      onApplied: () => { applied = true; root.dispatchEvent(new Event('infomatyka_progress_updated')); root.dispatchEvent(new Event('infomatyka_drive_applied')); }
    });
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
        prefs.fetchLatest = false;
      }
      initializeAccount(user);
      notice = 'Połączono. Wybierz zakres i kliknij „Synchronizuj”.';
    } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
    finally { authorizing = false; render(); }
    if (connected() && prefs.selected.length && (continuation || prefs.fetchLatest)) await synchronize(null, !continuation && prefs.fetchLatest);
  }
  async function prepare() {
    if (!configured) { render(); return; }
    try {
      if (!root.isSecureContext || !root.crypto.subtle) throw new Error('Synchronizacja wymaga HTTPS lub localhost.');
      if (!root.navigator.locks) throw new Error('Ta przeglądarka nie obsługuje bezpiecznej synchronizacji wielu kart. Użyj aktualnej przeglądarki.');
      if (!root.localforage) throw new Error('Nie załadowano pamięci danych. Odśwież stronę.');
      await loadGIS();
      client = root.google.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope: SCOPE,
        include_granted_scopes: false, callback: receiveToken,
        error_callback: () => { authorizing = false; afterAuth = null; notice = 'Okno Google zostało zamknięte lub zablokowane. Kliknij przycisk połączenia ponownie.'; render(); }
      });
      ready = true;
      let saved; try { saved = JSON.parse(root.sessionStorage.getItem(SESSION_KEY)); } catch (_) { }
      if (saved && saved.clientId === config.clientId && object(saved.token) && typeof saved.token.accessToken === 'string' &&
          Number.isFinite(saved.token.expiresAt) && saved.token.expiresAt > Date.now() && saved.accountId === prefs.boundAccount) {
        authorizing = true; notice = 'Przywracanie połączenia z Google Drive…'; render(); token = saved.token;
        try {
          const user = await identifyAccount();
          if (user.permissionId !== saved.accountId) throw new Error('Konto Google zmieniło się. Połącz ponownie.');
          initializeAccount(user); notice = 'Połączenie zachowane. Kliknij „Synchronizuj”, aby sprawdzić dane.';
        } catch (e) { token = null; account = null; engine = null; clearSession(); notice = e.message; }
        finally { authorizing = false; }
      } else clearSession();
      render();
      if (connected() && prefs.fetchLatest && prefs.selected.length) await synchronize(null, true);
    } catch (e) { notice = e.message; render(); }
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
  async function inspectAll(selected) {
    // Independent categories are read together; changing a checkbox never calls this.
    const results = await Promise.allSettled(selected.map(category => engine.inspect(category)));
    return results.map((result, index) => result.status === 'fulfilled' ? result.value : { category: selected[index], error: result.reason.message });
  }
  async function synchronize(source = null, fetchLatest = false) {
    if (busy || authorizing || !prefs.selected.length) return;
    if (!connected() || !engine) { beginConnect(false, { synchronize: true }); return; }
    const selected = [...prefs.selected];
    const reviewed = comparisons.filter(review => selected.includes(review.category));
    busy = true; notice = source ? 'Synchronizowanie wybranych danych…' : 'Porównywanie danych lokalnych i Google Drive…'; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
        if (latest.boundAccount !== account.permissionId || stable(latest.selected) !== stable(selected)) throw new Error('Konto lub zakres zmieniły się w innej karcie. Kliknij „Synchronizuj” ponownie.');
        const fresh = await inspectAll(selected);
        if (source) {
          // Validate the complete comparison before any category is changed.
          if (fresh.some(review => review.error) || fresh.some(review => {
            const previous = reviewed.find(item => item.category === review.category);
            return !previous || previous.localHash !== review.localHash || previous.signature !== review.signature;
          })) {
            comparisons = fresh; cloudChoices = Object.create(null);
            notice = 'Dane zmieniły się od czasu porównania. Sprawdź aktualne różnice i wybierz ponownie.'; return;
          }
          const changes = fresh.filter(differs).filter(review => source === 'local' || review.cloud.length);
          if (source === 'cloud' && changes.some(review => !chosenCloud(review))) {
            comparisons = fresh; notice = 'Wybierz wersję Drive w kategoriach z równoległymi zmianami.'; return;
          }
          const results = await Promise.allSettled(changes.map(review => engine.sync(review.category, {
            signature: review.signature, localHash: review.localHash,
            source: source === 'local' ? 'local' : chosenCloud(review).fileId
          })));
          const failures = results.flatMap((result, index) => result.status === 'rejected' ? [CATEGORIES[changes[index].category].label + ': ' + result.reason.message] : []);
          const stale = results.some(result => result.status === 'fulfilled' && result.value.action === 'conflict');
          comparisons = failures.length || stale ? await inspectAll(selected) : [];
          cloudChoices = Object.create(null);
          notice = failures.length ? 'Nie udało się zakończyć wszystkich zmian. ' + failures.join(' ') : stale ?
            'Część danych zmieniła się podczas synchronizacji. Sprawdź nowe porównanie.' :
            source === 'local' ? 'Zapisano wybrane dane lokalne na Google Drive.' : 'Wczytano dostępne dane z Google Drive. Kategorie bez kopii na Drive pozostają bez zmian.';
        } else {
          comparisons = fresh; cloudChoices = Object.create(null);
          if (fetchLatest) {
            // Only an unmodified local state or an empty first-time device may be replaced automatically.
            // Never upload here; local edits/deletions and concurrent cloud heads require a decision.
            const safe = fresh.filter(review => !review.error && review.action === 'pull');
            const results = await Promise.allSettled(safe.map(review => engine.sync(review.category, {
              signature: review.signature, localHash: review.localHash, source: review.cloud[0].fileId, downloadOnly: true
            })));
            const completed = safe.filter((_, index) => results[index].status === 'fulfilled' && results[index].value.action === 'pull');
            comparisons = completed.length ? await inspectAll(selected) : fresh;
            results.forEach((result, index) => { if (result.status === 'rejected') comparisons = comparisons.map(review => review.category === safe[index].category ? { ...review, error: result.reason.message } : review); });
            notice = completed.length ? 'Pobrano najnowsze dane z Drive. ' : '';
          } else notice = '';
          notice += comparisons.some(review => review.error) ? 'Nie udało się porównać wszystkich danych. Szczegóły poniżej.' : comparisons.some(differs) ?
            'Dane różnią się. Wybierz zapis wersji lokalnej albo wczytanie wersji z Drive.' : 'Dane są zgodne; nie trzeba niczego nadpisywać.';
        }
        prefs = { ...prefs, ...JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}'), lastSync: new Date().toISOString() }; savePrefs();
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
      for (const category of Object.keys(CATEGORIES)) recovery.push(...(await backupStore.getItem(account.permissionId + ':' + category) || []));
      notice = recovery.length ? 'Wybierz kopię do przywrócenia na tym urządzeniu.' : 'Nie ma jeszcze kopii sprzed synchronizacji dla tego konta.';
    } catch (e) { notice = e.message; }
    render();
  }
  async function restoreCopy(copy) {
    if (!connected() || busy || !root.confirm('Przywrócić lokalnie dane „' + CATEGORIES[copy.category].label + '” z ' + formatDate(copy.at) + '?')) return;
    busy = true; render();
    try {
      await root.navigator.locks.request('infomatyka-drive-sync-v1', async () => {
        await engine.apply(copy.category, copy.data, await engine.capture(copy.category));
      });
      recovery = []; comparisons = []; cloudChoices = Object.create(null); notice = 'Przywrócono kopię lokalną. Drive zmieni się dopiero po wybraniu zapisu na Drive.';
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
  function latestDate(values) { return values.filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0]; }
  function confirmDirection(source) {
    const label = source === 'local' ? 'Zapisać wybrane dane lokalne na Google Drive? Zastąpią wersję Drive w tym zakresie.' :
      'Wczytać wybrane dane z Google Drive? Zastąpią dane lokalne w tym zakresie. Kategorie bez kopii Drive pozostaną bez zmian.';
    if (root.confirm(label + '\nPrzed zmianą zachowamy lokalne kopie.')) synchronize(source);
  }
  function renderComparison() {
    const box = text('section', '', 'im-drive-comparison'); box.append(text('h4', 'Porównanie wybranych danych'));
    const valid = comparisons.filter(review => !review.error);
    const different = valid.filter(differs), remote = valid.flatMap(review => chosenCloud(review) || review.cloud[0] || []);
    const localBytes = valid.reduce((sum, review) => sum + review.localVersion.bytes, 0);
    const cloudBytes = remote.reduce((sum, record) => sum + record.bytes, 0);
    const versions = text('div', '', 'im-drive-versions');
    const localCard = text('div', '', 'im-drive-version'); localCard.append(text('h5', 'Na tym urządzeniu'),
      text('p', valid.every(review => review.localVersion.empty) ? 'Brak zapisanych danych.' : 'Dane lokalne: ' + formatBytes(localBytes)),
      text('p', 'Stan wykryto: ' + formatDate(latestDate(valid.map(review => review.localVersion.observedAt)))));
    const localSaved = latestDate(valid.map(review => review.localVersion.savedAt));
    if (localSaved) localCard.append(text('p', 'Ostatni zapis tablicy: ' + formatDate(localSaved)));
    const cloudCard = text('div', '', 'im-drive-version'); cloudCard.append(text('h5', 'Na Google Drive'),
      text('p', remote.length ? 'Dane w chmurze: ' + formatBytes(cloudBytes) : 'Brak kopii w chmurze.'),
      text('p', remote.length ? 'Ostatni zapis: ' + formatDate(latestDate(remote.map(record => record.savedAt))) : 'Rozmiar: 0 B'));
    versions.append(localCard, cloudCard); box.append(versions);
    box.append(text('p', different.length ? 'Różnią się: ' + different.map(review => CATEGORIES[review.category].label).join(' · ') : 'Wersje są zgodne; nadpisanie nie jest potrzebne.', 'im-drive-help'));
    const detail = text('details', '', 'im-drive-details'); detail.append(text('summary', 'Szczegóły różnic i dat'));
    comparisons.forEach(review => {
      if (review.error) { detail.append(text('p', CATEGORIES[review.category].label + ': ' + review.error, 'im-drive-status')); return; }
      const record = chosenCloud(review) || review.cloud[0];
      const row = text('div', '', 'im-drive-diff-row'); row.append(text('strong', CATEGORIES[review.category].label),
        text('span', 'Lokalnie: ' + formatBytes(review.localVersion.bytes) + ' · ' + (review.localVersion.savedAt ? formatDate(review.localVersion.savedAt) : 'data zapisu nieznana; stan wykryto ' + formatDate(review.localVersion.observedAt))),
        text('span', record ? 'Drive: ' + formatBytes(record.bytes) + ' · ' + formatDate(record.savedAt) : 'Drive: brak kopii'),
        text('span', ['same', 'none'].includes(review.action) ? 'Zgodne' : !review.cloud.length ? 'Tylko lokalnie' : review.localVersion.empty ? 'Tylko na Drive' : 'Różna zawartość'));
      detail.append(row);
    }); box.append(detail);
    valid.filter(review => new Set(review.cloud.map(record => record.hash)).size > 1).forEach(review => {
      const label = text('label', 'Równoległe wersje: ' + CATEGORIES[review.category].label, 'im-drive-cloud-choice');
      const select = document.createElement('select'); select.disabled = busy;
      const initial = text('option', 'Wybierz kopię Drive'); initial.value = ''; select.append(initial);
      review.cloud.forEach(record => { const option = text('option', formatDate(record.savedAt) + ' · ' + formatBytes(record.bytes) + ' · urządzenie ' + record.device.slice(0, 8)); option.value = record.fileId; select.append(option); });
      select.value = cloudChoices[review.category] || ''; select.addEventListener('change', () => { cloudChoices[review.category] = select.value; render(); }); label.append(select); box.append(label);
    });
    const hasErrors = comparisons.some(review => review.error), needsCloud = different.filter(review => review.cloud.length);
    if (different.some(review => review.localVersion.uploadBytes > MAX_BYTES)) box.append(text('p', 'Część danych przekracza limit zapisu. Szczegóły są w sekcji „Limity i kopie zapasowe”. Możesz wczytać mniejszą wersję z Drive.', 'im-drive-status'));
    if (different.length) {
      const actions = text('div', '', 'im-drive-actions');
      actions.append(button('Zapisz dane lokalne na Drive', () => confirmDirection('local'), hasErrors || different.some(review => review.localVersion.uploadBytes > MAX_BYTES)),
        button('Wczytaj dane z Drive', () => confirmDirection('cloud'), hasErrors || !needsCloud.length || needsCloud.some(review => !chosenCloud(review))));
      box.append(actions, text('p', 'Wybór obejmuje zaznaczony zakres. Druga wersja może zostać nadpisana; wcześniej zachowamy kopię lokalną.', 'im-drive-help'));
    }
    return box;
  }
  function render() {
    if (!panel) return;
    panel.replaceChildren(); panel.append(text('h3', 'Synchronizacja z Google Drive'));
    panel.append(text('p', 'Zapisuj dane InfoMatyki na swoim Google Drive i przenoś je między urządzeniami. Aplikacja ma dostęp tylko do swojego prywatnego folderu, bez dostępu do Twoich dokumentów.'));
    const top = text('div', '', 'im-drive-toolbar');
    top.append(text('span', connected() ? 'Połączono: ' + (account.emailAddress || account.displayName) : prefs.accountEmail ? 'Konto: ' + prefs.accountEmail + ' · połączenie do odnowienia' : 'Najpierw zaloguj się do Google Drive.', 'im-drive-status'));
    top.append(button(connected() ? 'Zmień konto' : prefs.accountEmail ? 'Połącz ponownie' : 'Zaloguj się do Google Drive', () => beginConnect(connected()), !ready, 'im-drive-secondary'));
    if (connected()) top.append(button('Odłącz', disconnect, false, 'im-drive-secondary')); panel.append(top);
    const fetchLabel = text('label', '', 'im-drive-choice im-drive-fetch'); const fetchCheck = document.createElement('input'); fetchCheck.type = 'checkbox'; fetchCheck.checked = !!prefs.fetchLatest; fetchCheck.disabled = busy || authorizing;
    fetchCheck.addEventListener('change', () => { prefs.fetchLatest = fetchCheck.checked; savePrefs(); });
    fetchLabel.append(fetchCheck, text('span', 'Pobieraj zawsze najnowsze dane')); panel.append(fetchLabel);
    panel.append(text('p', 'Po połączeniu pobierz dane, jeśli urządzenie jest puste lub jego kopia nie była zmieniana. Przy własnych zmianach pokaż wybór: wczytać czy wysłać.', 'im-drive-help'));
    if (connected()) {
      const choices = document.createElement('fieldset'); choices.disabled = busy || authorizing; choices.className = 'im-drive-scope';
      choices.append(text('legend', 'Co synchronizować?'));
      const grid = text('div', '', 'im-drive-choice-grid');
      GROUPS.forEach(group => {
        const label = text('label', '', 'im-drive-choice im-drive-group'); const check = document.createElement('input'); check.type = 'checkbox';
        check.checked = group.categories.every(key => prefs.selected.includes(key)); check.indeterminate = !check.checked && group.categories.some(key => prefs.selected.includes(key));
        check.addEventListener('change', () => {
          prefs.selected = check.checked ? Object.keys(CATEGORIES).filter(key => prefs.selected.includes(key) || group.categories.includes(key)) : prefs.selected.filter(key => !group.categories.includes(key));
          comparisons = []; recovery = []; cloudChoices = Object.create(null); savePrefs(); notice = 'Zakres zmieniony. Kliknij „Synchronizuj”, aby porównać dane.'; render();
        });
        const caption = text('span', ''); caption.append(text('strong', group.label), text('small', group.detail)); label.append(check, caption); grid.append(label);
      }); choices.append(grid); panel.append(choices);
      panel.append(text('p', 'Wszystko jest domyślnie zaznaczone. Zmiana zaznaczeń nie uruchamia synchronizacji.', 'im-drive-help'));
      panel.append(button(busy ? 'Synchronizowanie…' : 'Synchronizuj', () => synchronize(), !prefs.selected.length));
      panel.append(text('p', 'Połączenie jest zachowane w tej karcie po odświeżeniu i powrocie do ustawień. Ważne do: ' + formatDate(new Date(token.expiresAt).toISOString()), 'im-drive-help'));
    } else if (!configured) panel.append(text('p', 'Administrator nie skonfigurował jeszcze połączenia Google Drive.', 'im-drive-help'));
    const status = text('p', notice, 'im-drive-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
    if (comparisons.length && connected()) panel.append(renderComparison());
    if (applied) panel.append(button('Odśwież widok po wczytaniu danych', () => root.location.reload()));
    const advanced = text('details', '', 'im-drive-details'); advanced.append(text('summary', 'Limity i kopie zapasowe'));
    advanced.append(text('p', 'Limity InfoMatyki: 8 MiB na zapis kategorii razem z obrazami i opisem, 100 plików urządzeń w kategorii oraz 5 lokalnych kopii na kategorię i konto. To limity aplikacji. Drive przechowuje bieżące wersje urządzeń, a kopie zajmują miejsce na koncie Google i na urządzeniu.', 'im-drive-help'));
    comparisons.filter(review => !review.error).forEach(review => advanced.append(text('p', CATEGORIES[review.category].label + ': pliki ' + review.fileCount + '/100 · zapis lokalny ' + formatBytes(review.localVersion.uploadBytes) + '/8 MiB', 'im-drive-help')));
    const recoveryActions = text('div', '', 'im-drive-actions'); recoveryActions.append(button('Pokaż kopie do przywrócenia', showRecovery, !connected(), 'im-drive-secondary'), button('Pobierz kopie lokalne', downloadRecovery, !root.localforage, 'im-drive-secondary')); advanced.append(recoveryActions);
    recovery.forEach(copy => advanced.append(button('Przywróć: ' + CATEGORIES[copy.category].label + ' · ' + formatDate(copy.at) + ' · ' + formatBytes(byteSize(copy.data)), () => restoreCopy(copy), false, 'im-drive-secondary')));
    panel.append(advanced); if (recovery.length) advanced.open = true;
  }
  root.InfoMatykaDrive = { categories: CATEGORIES, synchronize, disconnect, mount: async function (element) { panel = element; render(); await prepare(); } };
  root.addEventListener('storage', event => {
    if (event.key === SETTINGS_KEY || event.key === null) {
      try {
        const latest = JSON.parse(root.localStorage.getItem(SETTINGS_KEY));
        if (!latest || (account && latest.boundAccount !== account.permissionId)) { disconnect(); return; }
        prefs = { ...prefs, ...latest }; comparisons = []; recovery = []; cloudChoices = Object.create(null); render();
      } catch (_) { disconnect(); }
    }
  });
  setInterval(() => {
    if (panel && token && !connected()) { token = null; account = null; engine = null; comparisons = []; clearSession(); notice = 'Dostęp Google wygasł. Kliknij „Połącz ponownie”, aby odnowić połączenie z zapamiętanym kontem.'; render(); }
  }, 60000);
  function mountSettings() { const target = document.getElementById('infomatyka-drive-settings'); if (target) root.InfoMatykaDrive.mount(target); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSettings); else mountSettings();
})(typeof window !== 'undefined' ? window : globalThis);
