(function () {
    'use strict';

    function parseMarkdown(text) {
        if (!text) return '';

        let result = String(text);
        const placeholders = [];
        const token = (html) => {
            const id = placeholders.push(html) - 1;
            return `%%PARSEMARKDOWN${id}%%`;
        };

        result = result.replace(/(?:^|\n)(\|[^\n]+\|\r?\n\|[ :|\-]+\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/g, (match) => {
            const lines = match.trim().split(/\r?\n/);
            const cells = (line) => line.split('|').map((cell) => cell.trim()).slice(1, -1);
            const headers = cells(lines[0]);
            let table = '<div style="overflow-x:auto; margin:12px 0;"><table class="generated-task-table" style="border-collapse:collapse; width:100%; border:1px solid var(--border-color, #cbd5e1); background:var(--surface-color, #fff); text-align:left;">';

            table += '<thead><tr style="background:rgba(128,128,128,0.1); border-bottom:2px solid var(--border-color, #cbd5e1);">';
            headers.forEach((header) => {
                table += `<th style="padding:8px 12px; font-weight:600; border:1px solid var(--border-color, #cbd5e1); font-size:13px; color:var(--text-color, #1e293b);">${header}</th>`;
            });
            table += '</tr></thead><tbody>';

            lines.slice(2).forEach((line) => {
                const row = cells(line);
                if (!row.length) return;
                table += '<tr style="border-bottom:1px solid var(--border-color, #cbd5e1);">';
                row.forEach((cell) => {
                    table += `<td style="padding:8px 12px; border:1px solid var(--border-color, #cbd5e1); font-size:13px; color:var(--text-color, #334155);">${cell}</td>`;
                });
                table += '</tr>';
            });

            return token(`${table}</tbody></table></div>`);
        });

        result = result.replace(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/g, (match, code) => {
            const clean = code
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/div><div>/gi, '\n')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            return token(`<pre class="mathjax-ignore" style="background:var(--pre-bg, #1e1e2e); padding:14px; margin:12px 0; border:1px solid var(--border-color, #313244); border-radius:8px; overflow-x:auto; font-family:Consolas, Monaco, monospace; color:var(--text-color, #cdd6f4); white-space:pre-wrap;"><code>${clean}</code></pre>`);
        });

        result = result.replace(/`([^`]+)`/g, (match, code) => {
            const clean = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return token(`<code class="mathjax-ignore" style="background:var(--code-bg, #f1f5f9); color:var(--text-color, #0f172a); padding:2px 6px; border:1px solid var(--border-color, #cbd5e1); border-radius:4px; font-family:Consolas, Monaco, monospace; font-size:0.9em; font-weight:600;">${clean}</code>`);
        });

        result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match) => token(match));
        result = result.replace(/\$([\s\S]*?)\$/g, (match) => token(match));
        result = result.replace(/\\+dotfill/gi, '....................');

        result = result.replace(/(?:^|\n)###\s+([^\n]+)/g, '\n<h3 style="margin-top:10px; margin-bottom:8px; font-size:1.15rem; font-weight:700;">$1</h3>');
        result = result.replace(/(?:^|\n)##\s+([^\n]+)/g, '\n<h2 style="margin-top:12px; margin-bottom:10px; font-size:1.3rem; font-weight:700;">$1</h2>');
        result = result.replace(/(?:^|\n)#\s+([^\n]+)/g, '\n<h1 style="margin-top:14px; margin-bottom:12px; font-size:1.5rem; font-weight:700;">$1</h1>');
        result = result.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
        result = result.replace(/__([\s\S]*?)__/g, '<strong>$1</strong>');
        result = result.replace(/\*([\s\S]*?)\*/g, '<em>$1</em>');
        result = result.replace(/_([\s\S]*?)_/g, '<em>$1</em>');
        result = result.replace(/\r\n/g, '\n').replace(/\n-\s+/g, '<br>&bull; ').replace(/^-\s*/g, '&bull; ').replace(/\n/g, '<br>');

        placeholders.forEach((html, index) => {
            result = result.split(`%%PARSEMARKDOWN${index}%%`).join(html);
        });
        return result;
    }

    window.parseMarkdown = parseMarkdown;
    window.parseMarkdownVersion = '2026.07.23.2';
}());
