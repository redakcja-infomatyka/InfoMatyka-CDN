(function (global) {
    'use strict';
    const RUNTIME_CSS = `
/* Każdy selektor pozostaje wewnątrz lekcji, także przy osadzeniu w Bloggerze. */
.im-lesson { --im-brand:#147d90; --im-ink:#20313b; --im-line:#dce5e8; box-sizing:border-box; width:100%; max-width:1200px; margin:0 auto; padding:clamp(16px,3vw,40px); background:#fff; color:var(--im-ink); font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif; text-align:left; overflow-wrap:anywhere; color-scheme:light; }
.im-lesson *, .im-lesson *::before, .im-lesson *::after { box-sizing:border-box; }
.im-lesson [hidden] { display:none!important; }
.im-lesson h1, .im-lesson h2, .im-lesson h3 { color:var(--im-ink); font-family:inherit; font-weight:750; line-height:1.25; margin:0 0 20px; text-transform:none; }
.im-lesson h1 { font-size:clamp(28px,4vw,42px); }
.im-lesson h2 { font-size:28px; }
.im-lesson h3 { font-size:22px; }
.im-lesson p { margin:0 0 18px; font:inherit; color:inherit; }
.im-lesson a { color:var(--im-brand); text-decoration:underline; }
.im-lesson .im-section { width:100%; padding:24px 0; }
.im-lesson .im-container { width:100%; max-width:960px; margin:0 auto; padding:16px; }
.im-lesson .im-columns { display:grid; gap:24px; grid-template-columns:repeat(2,minmax(0,1fr)); margin:0 0 24px; }
.im-lesson .im-columns.im-30-70 { grid-template-columns:minmax(0,3fr) minmax(0,7fr); }
.im-lesson .im-columns.im-70-30 { grid-template-columns:minmax(0,7fr) minmax(0,3fr); }
.im-lesson .im-columns.im-three { grid-template-columns:repeat(3,minmax(0,1fr)); }
.im-lesson .im-column { min-width:0; min-height:60px; }
.im-lesson .im-card, .im-lesson .im-callout, .im-lesson .im-quiz, .im-lesson .im-reveal { padding:24px; margin:0 0 24px; border:1px solid var(--im-line); border-radius:16px; background:#fff; box-shadow:0 3px 12px #20313b08; }
.im-lesson .im-callout { border-left:5px solid var(--im-brand); background:#eaf8fa; }
.im-lesson .im-important { border-left-color:#bc7720; background:#fff7e8; }
.im-lesson .im-example { border-left-color:#427b54; background:#eef8f0; }
.im-lesson .im-fact { border-left-color:#7560a6; background:#f4f0fc; }
.im-lesson .im-callout-title { font-weight:750; font-size:19px; margin-bottom:10px; }
.im-lesson .im-callout-body { white-space:pre-wrap; }
.im-lesson button, .im-lesson .im-button { appearance:none; display:inline-block; font:600 16px/1.5 system-ui,sans-serif; color:var(--im-ink); background:#f5f8f9; border:1px solid var(--im-line); border-radius:10px; padding:12px 18px; cursor:pointer; text-decoration:none; text-transform:none; letter-spacing:normal; box-shadow:none; height:auto; }
.im-lesson button:hover, .im-lesson .im-button:hover { background:#eaf8fa; border-color:var(--im-brand); }
.im-lesson button:focus-visible, .im-lesson a:focus-visible { outline:3px solid #147d9080; outline-offset:3px; }
.im-lesson .im-primary { background:var(--im-brand); color:#fff; border-color:var(--im-brand); }
.im-lesson .im-primary:hover { background:#106575; color:#fff; }
.im-lesson .im-outline { background:#fff; color:var(--im-brand); border-color:var(--im-brand); }
.im-lesson .im-quiz-question { font-size:20px; font-weight:700; margin-bottom:16px; white-space:pre-wrap; }
.im-lesson .im-answers { display:grid; gap:10px; }
.im-lesson .im-answers button { width:100%; text-align:left; }
.im-lesson .im-answers button.im-correct { color:#17613a; border-color:#24834d; background:#e7f6ec; }
.im-lesson .im-answers button.im-incorrect { color:#943737; border-color:#b24b4b; background:#fceeee; }
.im-lesson .im-feedback { min-height:28px; margin-top:14px; font-weight:650; }
.im-lesson .im-feedback[data-result="correct"] { color:#17613a; }
.im-lesson .im-feedback[data-result="incorrect"] { color:#943737; }
.im-lesson [data-reveal-content] { margin-top:16px; white-space:pre-wrap; }
.im-lesson figure { margin:0 0 24px; width:100%; }
.im-lesson img { display:block; max-width:100%; height:auto; border-radius:12px; margin:0 auto; }
.im-lesson figcaption { color:#60717a; font-size:14px; text-align:center; margin-top:8px; }
.im-lesson iframe { display:block; width:100%; height:auto; aspect-ratio:16/9; border:1px solid var(--im-line); border-radius:12px; background:#f5f8f9; }
.im-lesson hr { border:0; border-top:1px solid var(--im-line); margin:24px 0; }
.im-lesson .im-spacer { height:32px; }
@media (max-width:600px) { .im-lesson .im-columns, .im-lesson .im-columns.im-30-70, .im-lesson .im-columns.im-70-30, .im-lesson .im-columns.im-three { grid-template-columns:minmax(0,1fr); } .im-lesson .im-card, .im-lesson .im-callout, .im-lesson .im-quiz, .im-lesson .im-reveal { padding:18px; } }
@media (prefers-reduced-motion:reduce) { .im-lesson * { scroll-behavior:auto!important; } }
`;
    if (!document.getElementById('im-lesson-runtime-style')) {
        const style = document.createElement('style');
        style.id = 'im-lesson-runtime-style';
        style.textContent = RUNTIME_CSS;
        (document.head || document.documentElement).appendChild(style);
    }
    if (global.LessonRuntime) {
        global.LessonRuntime.init();
        return;
    }
    const mounted = new WeakSet();
    const components = Object.create(null);
    const LessonRuntime = {
        version: '0.1.1',
        components,
        register(name, mount) {
            if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof mount !== 'function') {
                throw new TypeError('Niepoprawna rejestracja komponentu lekcji.');
            }
            components[name] = mount;
        },
        init(root = document) {
            const elements = Array.from(root.querySelectorAll('[data-im-component]'));
            if (root.matches && root.matches('[data-im-component]')) elements.unshift(root);
            elements.forEach(element => {
                if (!element.closest('.im-lesson') || mounted.has(element)) return;
                const mount = components[element.dataset.imComponent];
                if (!mount) return;
                try {
                    mount(element);
                    mounted.add(element);
                    element.dataset.imInitialized = 'true';
                } catch (error) {
                    console.error('[InfoMatyka] Nie można uruchomić komponentu:', element, error);
                    element.dataset.imError = 'true';
                }
            });
        }
    };

    function mountChoice(element) {
        const buttons = Array.from(element.querySelectorAll('[data-answer]'))
            .filter(button => button.closest('[data-im-component]') === element);
        const correct = element.dataset.correct;
        if (!buttons.length || !buttons.some(button => button.dataset.answer === correct)) {
            throw new Error('Brak poprawnej odpowiedzi w ćwiczeniu.');
        }
        const feedback = element.querySelector('.im-feedback');
        if (!feedback) throw new Error('Brak pola informacji zwrotnej.');
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        buttons.forEach(button => {
            button.type = 'button';
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => {
                buttons.forEach(answer => {
                    answer.classList.remove('im-correct', 'im-incorrect');
                    answer.setAttribute('aria-pressed', 'false');
                });
                const success = button.dataset.answer === correct;
                button.classList.add(success ? 'im-correct' : 'im-incorrect');
                button.setAttribute('aria-pressed', 'true');
                feedback.textContent = success
                    ? (element.dataset.success || 'Dobrze! Poprawna odpowiedź.')
                    : (element.dataset.failure || 'Spróbuj ponownie.');
                feedback.dataset.result = success ? 'correct' : 'incorrect';
            });
        });
    }
    LessonRuntime.register('single-choice', element => {
        if (!/^[0-3]$/.test(element.dataset.correct || '')) {
            throw new Error('Indeks odpowiedzi musi być liczbą od 0 do 3.');
        }
        const answers = Array.from(element.querySelectorAll('[data-answer]')).filter(button => button.closest('[data-im-component]') === element).map(button => button.dataset.answer).sort();
        if (answers.join(',') !== '0,1,2,3') throw new Error('Quiz wymaga czterech odpowiedzi o indeksach 0–3.');
        mountChoice(element);
    });
    LessonRuntime.register('true-false', element => {
        if (!['true', 'false'].includes(element.dataset.correct)) {
            throw new Error('Odpowiedź musi mieć wartość true lub false.');
        }
        const answers = Array.from(element.querySelectorAll('[data-answer]')).filter(button => button.closest('[data-im-component]') === element).map(button => button.dataset.answer).sort();
        if (answers.join(',') !== 'false,true') throw new Error('Ćwiczenie wymaga odpowiedzi Prawda i Fałsz.');
        mountChoice(element);
    });
    LessonRuntime.register('reveal', element => {
        const button = element.querySelector('[data-reveal-button]');
        const content = element.querySelector('[data-reveal-content]');
        if (!button || !content) throw new Error('Niepełny komponent odkrywania.');
        content.hidden = true;
        button.type = 'button';
        button.setAttribute('aria-expanded', 'false');
        const label = button.textContent;
        button.addEventListener('click', () => {
            content.hidden = !content.hidden;
            button.setAttribute('aria-expanded', String(!content.hidden));
            button.textContent = content.hidden ? label : (element.dataset.hideLabel || 'Ukryj odpowiedź');
        });
    });
    global.LessonRuntime = LessonRuntime;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => LessonRuntime.init(), { once: true });
    } else {
        LessonRuntime.init();
    }
})(window);