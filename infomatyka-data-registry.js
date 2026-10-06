(function (root) {
  'use strict';
  if (root.InfoMatykaDataRegistry) return;

  const datasets = [
    { id: 'profile.user', label: 'Profil użytkownika', module: 'profile', key: 'infomatyka-profile-user', category: 'profile', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'profile.accessibility', label: 'Dostępność', module: 'profile', key: 'infomatyka-profile-accessibility', category: 'profile', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'progress.state', label: 'Postęp i osiągnięcia', module: 'progress', key: 'infomatyka-progress-state', category: 'progress', storage: 'localStorage', schema: 1, syncStrategy: 'nested-entity-three-way', dataClass: 'entity' },
    { id: 'progress.events', label: 'Zdarzenia postępu', module: 'progress', key: 'infomatyka-progress-events', category: 'progress', storage: 'localStorage', schema: 1, syncStrategy: 'event-union', dataClass: 'event' },
    { id: 'learning.progress', label: 'Progres nauki', module: 'progress', key: 'infomatyka-learning-progress', category: 'learning', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'entity' },
    { id: 'learning.curriculum-overrides', label: 'Własne oznaczenia podstawy programowej', module: 'curriculum', key: 'infomatyka-learning-curriculum-overrides', category: 'learning', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'entity' },
    { id: 'favorites.articles', label: 'Ulubione artykuły', module: 'favorites', key: 'infomatyka-favorites-articles', category: 'favorites', storage: 'localStorage', schema: 1, syncStrategy: 'set-union', dataClass: 'set' },
    { id: 'generator.sets', label: 'Zestawy testów', module: 'generator', key: 'infomatyka-generator-test-sets', category: 'generator', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'generator.quick-quizzes', label: 'Szybkie kartkówki', module: 'generator', key: 'infomatyka-generator-quick-quizzes', category: 'generator', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'generator.custom-modules', label: 'Własne zadania i moduły', module: 'generator', key: 'infomatyka-generator-custom-questions', category: 'generator', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'generator.latex-scale', label: 'Skala LaTeX generatora', module: 'generator', key: 'infomatyka-generator-latex-scale', category: 'generator', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'setting' },
    { id: 'generator.ignored-questions', label: 'Ukryte brakujące zadania', module: 'generator', key: 'infomatyka-generator-ignored-tasks', category: 'generator', storage: 'localStorage', schema: 1, syncStrategy: 'set-union', dataClass: 'set' },
    { id: 'teacher.records', label: 'Klasy, lekcje i dziennik', module: 'teacher', key: 'infomatyka-teacher-records', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'nested-entity-three-way', dataClass: 'entity', dependencies: [] },
    { id: 'teacher.sessions', label: 'Archiwalne wyniki testów', module: 'teacher', key: 'infomatyka-teacher-session-archive', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'teacher.report-settings', label: 'Ustawienia raportów', module: 'teacher', key: 'infomatyka-teacher-report-settings', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'teacher.grade-thresholds', label: 'Progi ocen', module: 'teacher', key: 'infomatyka-teacher-grade-thresholds', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'teacher.recommendations', label: 'Rekomendacje nauczyciela', module: 'teacher', key: 'infomatyka-teacher-recommendations', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'teacher.feedback-generator', label: 'Generator ocen i informacji zwrotnej', module: 'teacher', key: 'infomatyka-generator-feedback-data', category: 'teacher', storage: 'localStorage', schema: 1, syncStrategy: 'nested-entity-three-way', dataClass: 'entity' },
    { id: 'account.setup-settings', label: 'Ustawienia profilu', module: 'profile', key: 'infomatyka-account-setup-settings', category: 'profile', storage: 'localStorage', schema: 1, syncStrategy: 'field-merge', dataClass: 'settings' },
    { id: 'materials.saved', label: 'Własne materiały generatora', module: 'materials', key: 'infomatyka-generator-saved-materials', category: 'materials', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'materials.projects', label: 'Projekty Kreatora Materiałów', module: 'materials', key: 'infomatyka-material-creator-projects', category: 'materials', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'calendar.user-events', label: 'Własne wydarzenia kalendarza', module: 'calendar', key: 'infomatyka-calendar-user-events', category: 'calendar', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'organizer.classes', label: 'Układy grup i miejsca w klasie', module: 'class-organizer', key: 'infomatyka-class-organizer-layouts', category: 'organizer', storage: 'localStorage', schema: 1, syncStrategy: 'nested-entity-three-way', dataClass: 'entity' },
    { id: 'duty.plans', label: 'Plany dyżurów', module: 'duty-planner', key: 'infomatyka-duty-plans', category: 'duty', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'spe.adjustment-bank', label: 'Własny bank dostosowań SPE', module: 'spe', key: 'infomatyka-spe-customization-bank', category: 'spe', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'spe.functional-areas', label: 'Własne obszary funkcjonalne SPE', module: 'spe', key: 'infomatyka-spe-functional-areas', category: 'spe', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'spe.projects', label: 'Projekty dostosowań SPE', module: 'spe', key: 'infomatyka-spe-adjustment-projects', category: 'spe', storage: 'localStorage', schema: 1, syncStrategy: 'entity-three-way', dataClass: 'entity' },
    { id: 'boards.library', label: 'Tablice, strony i assety', module: 'boards', category: 'boards', storage: 'indexedDB:infomatyka_tablice_interaktywne', schema: 4, syncStrategy: 'nested-entity-three-way', dataClass: 'entity', binary: 'sha256-manifest', dependencies: ['materials.projects'] },
    { id: 'generator.task-cache', label: 'Publiczna baza zadań', module: 'generator', key: 'infomatyka-generator-task-cache', storage: 'localforage', fallback: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'remote-authoritative', reason: 'Odtwarzalna baza dostarczana przez InfoMatykę; do synchronizacji trafiają tylko własne zadania.' },
    { id: 'teacher.roster-cache', label: 'Kopia list klas dla portalu', module: 'teacher', key: 'infomatyka-teacher-roster-cache', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'derived', reason: 'Kopia wyliczana z teacher.records.' },
    { id: 'teacher.active-session', label: 'Aktywna sesja testowa', module: 'teacher', key: 'infomatyka-session-active-test', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Bieżący stan sesji online.' },
    { id: 'student.active-session', label: 'Sesja portalu ucznia', module: 'student-portal', key: 'infomatyka-session-student', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Chwilowe połączenie i stan ucznia.' },
    { id: 'student.transport-message', label: 'Wiadomości synchronizacji portalu', module: 'student-portal', key: 'infomatyka-session-sync-message', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Transport Firebase/BroadcastChannel, nie dane archiwalne.' },
    { id: 'teacher.download-history', label: 'Historia pobrań tablic', module: 'teacher', key: 'infomatyka-teacher-download-history', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Pomocnicza historia pobrań na tym urządzeniu.' },
    { id: 'duty.drafts', label: 'Szkice generatora dyżurów', module: 'duty-planner', key: 'infomatyka-ui-duty-drafts', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Tymczasowe szkice interfejsu.' },
    { id: 'website.banner-dismissal', label: 'Zamknięcie banera strony', module: 'website', key: 'infomatyka-device-page-banner-dismissed', storage: 'sessionStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Jednorazowe zamknięcie banera w bieżącej karcie.' },
    { id: 'website.cookie-preferences', label: 'Zgody cookies', module: 'website', key: 'infomatyka-device-cookie-preferences', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Zgody i prezentacja na tym urządzeniu.' },
    { id: 'website.drive-indicator', label: 'Widoczność wskaźnika synchronizacji', module: 'website', key: 'infomatyka-device-drive-indicator-visible', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Preferencja interfejsu.' },
    { id: 'calendar.working-days-mode', label: 'Tryb dni roboczych', module: 'calendar', key: 'infomatyka-device-calendar-working-days-only', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Preferencja widoku publicznego kalendarza.' },
    { id: 'calendar.user-events-visibility', label: 'Widoczność własnych wydarzeń', module: 'calendar', key: 'infomatyka-ui-calendar-user-events-visible', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Preferencja widoku kalendarza.' },
    { id: 'calendar.oral-answer-choice', label: 'Ostatni wybór w pytaniach ustnych', module: 'oral-qa', key: 'infomatyka-ui-calendar-oral-answer-choice', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Wybór filtrów i aktywnego ucznia.' },
    { id: 'account.local-profiles', label: 'Lokalne konta przeglądarki', module: 'account', key: 'infomatyka-device-account-<id>', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'credential', reason: 'Lokalna nazwa użytkownika i hasło; nigdy nie trafia na Drive.' },
    { id: 'account.local-session', label: 'Aktywne konto lokalne', module: 'account', key: 'infomatyka-session-current-user', storage: 'sessionStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Bieżący profil przeglądarki.' },
    { id: 'generator.templates-cache', label: 'Cache szablonów generatora', module: 'generator', key: 'infomatyka-generator-cache-templates', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'cache', reason: 'Kopia odtwarzalna z GitHub/CDN.' },
    { id: 'generator.quick-quizzes-cache', label: 'Cache szybkich kartkówek', module: 'generator', key: 'infomatyka-generator-cache-quick-quizzes', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'cache', reason: 'Kopia odtwarzalna z GitHub/CDN.' },
    { id: 'generator.curriculum-cache', label: 'Cache podstawy programowej', module: 'generator', key: 'infomatyka-generator-cache-curriculum', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'cache', reason: 'Kopia odtwarzalna z GitHub/CDN.' },
    { id: 'game.race-settings', label: 'Ustawienia i wynik gry edukacyjnej', module: 'games', key: 'infomatyka-games-race-settings', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Dane pojedynczej gry na tym urządzeniu.' },
    { id: 'website.full-layout-session', label: 'Tryb pełnej strony', module: 'website', key: 'infomatyka-session-force-full-layout', storage: 'sessionStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Jednorazowa preferencja prezentacji strony.' },
    { id: 'boards.toolbar-layout', label: 'Układ paska narzędzi tablicy', module: 'boards', key: 'infomatyka-device-board-toolbar-layout', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Stan widoku na konkretnym urządzeniu.' },
    { id: 'boards.palm-eraser', label: 'Ustawienia gumki dłoniowej', module: 'boards', key: 'infomatyka-device-board-palm-eraser', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Ustawienia sprzętowe/interfejsu.' },
    { id: 'boards.clock-display', label: 'Widoczność zegara tablicy', module: 'boards', key: 'infomatyka-device-board-clock-display', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Preferencja widoku na tym urządzeniu.' },
    { id: 'portal.firebase-sessions', label: 'Sesje Firebase portalu testowego', module: 'teacher-portal', storage: 'Firebase Realtime Database', schema: null, syncStrategy: 'none', dataClass: 'remote-authoritative', reason: 'Trwałe dla aktywnego testu, ale źródłowo zarządzane przez Firebase; nie dublować ich na Drive.' },
    { id: 'account.firebase-profile', label: 'Profil konta online', module: 'account', storage: 'Firebase Authentication / Cloud Firestore', schema: null, syncStrategy: 'none', dataClass: 'remote-authoritative', reason: 'Źródłem prawdy jest usługa kont; lokalny stan jest sesją Firebase.' },
    { id: 'drive.oauth-session', label: 'Sesja OAuth Drive', module: 'drive-sync', key: 'infomatyka-sync-session', storage: 'sessionStorage', schema: 1, syncStrategy: 'none', dataClass: 'credential', reason: 'Token dostępu jest sesyjny i nigdy nie trafia na Drive.' },
    { id: 'drive.preferences', label: 'Preferencje synchronizacji Drive', module: 'drive-sync', key: 'infomatyka-sync-preferences', storage: 'localStorage', schema: 3, syncStrategy: 'none', dataClass: 'device-local', reason: 'Zakres i tryb synchronizacji są lokalne dla przeglądarki.' },
    { id: 'drive.device-id', label: 'Identyfikator urządzenia Drive', module: 'drive-sync', key: 'infomatyka-sync-device', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Rozpoznaje to urządzenie w metadanych synchronizacji.' },
    { id: 'drive.category-state', label: 'Stan sprawdzenia kategorii Drive', module: 'drive-sync', key: 'infomatyka-sync-state-<account>-<category>', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Wskaźniki lokalnych zmian, ostatniego sprawdzenia i wersji chmurowej.' },
    { id: 'drive.checkpoint', label: 'Punkt kontrolny Drive', module: 'drive-sync', key: 'infomatyka-sync-checkpoint-<account>-<category>', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Hash i wektor po zatwierdzonej synchronizacji.' },
    { id: 'drive.hydration-state', label: 'Blokada przywracania danych', module: 'drive-sync', key: 'infomatyka-sync-hydration-<category>', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Krótko żyjący znacznik blokujący pętlę obserwatora podczas Pull.' },
    { id: 'drive.edit-lease', label: 'Blokada edycji strony', module: 'drive-sync', key: 'infomatyka-sync-edit-<tab>', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'session', reason: 'Krótko żyjąca blokada ostrzegająca inne karty.' },
    { id: 'drive.bases', label: 'Bazy porównawcze synchronizacji', module: 'drive-sync', key: 'infomatyka-sync-bases/datasets', storage: 'localforage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Kopie bazowe per konto i dataset do trójstronnego porównania.' },
    { id: 'drive.recovery', label: 'Kopie odzyskiwania synchronizacji', module: 'drive-sync', key: 'infomatyka-sync-recovery/copies', storage: 'localforage', schema: 1, syncStrategy: 'none', dataClass: 'device-local', reason: 'Lokalne kopie poprzedzające zmianę danych i możliwość odzyskania.' },
    { id: 'drive.asset-revision', label: 'Wersja modułów CDN', module: 'website', key: 'infomatyka-sync-assets', storage: 'localStorage', schema: 1, syncStrategy: 'none', dataClass: 'cache', reason: 'Znacznik odświeżania modułów strony z CDN.' },
  ];

  function categoryDefinitions() {
    const categories = {};
    for (const dataset of datasets) {
      if (dataset.syncStrategy === 'none') continue;
      if (!categories[dataset.category]) categories[dataset.category] = { label: '', keys: [], datasets: [], boards: false };
      const category = categories[dataset.category];
      category.datasets.push(dataset.id);
      if (dataset.key) category.keys.push(dataset.key);
      if (dataset.id === 'boards.library') category.boards = true;
    }
    const labels = {
      profile: 'Profil, dostępność i ustawienia konta', progress: 'XP, osiągnięcia i postęp nauki',
      learning: 'Postęp w nauce', favorites: 'Ulubione artykuły', generator: 'Generator: zestawy i własne zadania',
      teacher: 'Klasy, dziennik, ustawienia i wyniki testów', materials: 'Własne materiały i projekty',
      organizer: 'Układy i organizacja klasy',
      calendar: 'Własne wydarzenia kalendarza', duty: 'Plany dyżurów', spe: 'Projekty dostosowań SPE',
      boards: 'Tablice interaktywne, strony, foldery i assety'
    };
    for (const [id, category] of Object.entries(categories)) category.label = labels[id] || id;
    return categories;
  }

  function parse(raw, dataset) {
    if (raw === null || raw === undefined) return null;
    let value;
    try { value = JSON.parse(raw); }
    catch (_) { throw new Error('Dane „' + dataset.label + '” nie zawierają poprawnego JSON.'); }
    if (dataset.syncStrategy === 'event-union' && !Array.isArray(value)) throw new Error('Zdarzenia muszą być zapisaną listą.');
    if (dataset.syncStrategy === 'set-union' && !Array.isArray(value)) throw new Error('Zbiór musi być zapisaną listą.');
    return value;
  }

  function getDiagnostics() {
    return datasets.map(dataset => ({ datasetId: dataset.id, label: dataset.label, module: dataset.module,
      storage: dataset.storage, fallback: dataset.fallback || null, key: dataset.key || null, schema: dataset.schema, strategy: dataset.syncStrategy,
      dataClass: dataset.dataClass, reason: dataset.reason || null, dependencies: dataset.dependencies || [] }));
  }

  function stableId(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    return String(value.id || value.eventId || value.value || value.url || '');
  }

  function describe(datasetId, value) {
    const dataset = datasets.find(item => item.id === datasetId);
    if (!dataset) throw new Error('Nieznany zbiór danych: ' + datasetId);
    const recordCount = Array.isArray(value) ? value.length : value && typeof value === 'object'
      ? Object.keys(value).length : value == null ? 0 : 1;
    return { datasetId, label: dataset.label, storage: dataset.storage, key: dataset.key || null,
      strategy: dataset.syncStrategy, fallback: dataset.fallback || null, recordCount };
  }

  const registry = {
    version: '1.0.0',
    datasets: Object.freeze(datasets.map(dataset => Object.freeze(dataset))),
    categories: Object.freeze(categoryDefinitions()),
    get(datasetId) { return datasets.find(dataset => dataset.id === datasetId) || null; },
    getByKey(key) { return datasets.find(dataset => dataset.key === key) || null; },
    getDiagnostics,
    describe,
    async capture(datasetId, context) {
      const dataset = this.get(datasetId);
      if (!dataset) throw new Error('Nieznany zbiór danych: ' + datasetId);
      if (!dataset.key || dataset.storage !== 'localStorage') throw new Error('Zbiór wymaga adaptera: ' + dataset.storage);
      return context.storage.getItem(dataset.key);
    },
    validate(datasetId, raw) {
      const dataset = this.get(datasetId);
      if (!dataset) return false;
      if (raw === null || raw === undefined) return true;
      if (dataset.syncStrategy === 'event-union') return Array.isArray(raw) && raw.every(item => item && typeof item === 'object' && stableId(item));
      if (dataset.syncStrategy === 'set-union') return Array.isArray(raw) && raw.every(stableId);
      if (dataset.syncStrategy === 'entity-three-way') return Array.isArray(raw) && raw.every(item => item && typeof item === 'object' && stableId(item));
      return typeof raw === 'object' || ['string', 'number', 'boolean'].includes(typeof raw);
    },
    merge(datasetId, base, local, remote, mergeCore, options = {}) {
      const dataset = this.get(datasetId);
      if (!dataset) throw new Error('Nieznany zbiór danych: ' + datasetId);
      return mergeCore.mergeThreeWay(parse(base, dataset), parse(local, dataset), parse(remote, dataset), {
        dataset: dataset.id, strategy: dataset.syncStrategy, ...options
      });
    },
    apply(datasetId, raw, context) {
      const dataset = this.get(datasetId);
      const value = typeof raw === 'string' && dataset ? parse(raw, dataset) : raw;
      if (!dataset || !this.validate(datasetId, value)) throw new Error('Nie można zastosować nieprawidłowych danych.');
      if (!dataset.key || dataset.storage !== 'localStorage') throw new Error('Zbiór wymaga adaptera: ' + dataset.storage);
      if (raw === null) context.storage.removeItem(dataset.key);
      else context.storage.setItem(dataset.key, typeof raw === 'string' ? raw : JSON.stringify(raw));
    },
    async backup(datasetId, value, context = {}) {
      const dataset = this.get(datasetId);
      if (!dataset) throw new Error('Nieznany zbiór danych: ' + datasetId);
      if (typeof context.backup === 'function') return context.backup(dataset, value);
      return null;
    }
  };

  root.InfoMatykaDataRegistry = Object.freeze(registry);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.InfoMatykaDataRegistry;
})(typeof globalThis === 'object' ? globalThis : this);
