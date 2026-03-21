// ==UserScript==
// @name         Roster Filter
// @namespace    http://tampermonkey.net/
// @version      2.2
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @description  Simple roster filter
// @match        https://logistics.amazon.co.jp/internal/capacity/rosterview*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'rf-selected-filter';  // ← 追加：保存用キー

    const FILTERS = [
        { key: 'ALL', label: '全て表示', min: -1, max: -1 },
        { key: 'SSD_1', label: 'SSD_1', min: 0, max: 420 },
        { key: 'SSD_1_B', label: 'SSD_1_B', min: 420, max: 600 },
        { key: 'SSD_2', label: 'SSD_2', min: 600, max: 840 },
        { key: 'SSD_3', label: 'SSD_3', min: 840, max: 1020 },
        { key: 'SSD_3_B', label: 'SSD_3_B', min: 1020, max: 1200 },
        { key: 'SSD_4', label: 'SSD_4', min: 1200, max: Infinity }
    ];

    let cachedRows = null;

    const style = document.createElement('style');
    style.textContent = `
        #rf-panel{position:fixed;top:55px;right:10px;background:#fff;border:2px solid #232f3e;border-radius:6px;padding:10px;z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,0.2);font:12px Arial,sans-serif;min-width:120px}
        #rf-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid #ff9900}
        #rf-header span{font-weight:bold;font-size:13px}
        #rf-toggle{background:none;border:none;font-size:16px;cursor:pointer;padding:0 4px}
        #rf-content{display:block}
        #rf-content.hide{display:none}
        #rf-panel label{display:block;margin:4px 0;cursor:pointer}
        #rf-panel input{margin-right:6px}
        #rf-count{margin-top:8px;padding:6px;background:#f5f5f5;border-radius:3px}
        #rf-refresh{padding:4px 8px;margin-top:8px;cursor:pointer;border:1px solid #232f3e;border-radius:3px;font-size:11px;width:100%}
        .rf-hide{display:none!important}
    `;
    document.head.appendChild(style);

    // ← 追加：保存された値を取得
    function getSavedFilter() {
        return localStorage.getItem(STORAGE_KEY) || 'ALL';
    }

    // ← 追加：フィルター値を保存
    function saveFilter(key) {
        localStorage.setItem(STORAGE_KEY, key);
    }

    function parseTime(str) {
        if (!str) return null;
        const m = str.match(/(\d+):(\d+)\s*(am|pm)/i);
        if (!m) return null;
        let h = parseInt(m[1]);
        if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
        if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
        return h * 60 + parseInt(m[2]);
    }

    function getCategory(min) {
        if (min === null) return null;
        for (const f of FILTERS) {
            if (f.key === 'ALL') continue;
            if (f.min === f.max ? min === f.min : min >= f.min && min < f.max) return f.key;
        }
        return null;
    }

    function doFilter() {
        const selected = document.querySelector('#rf-panel input:checked');
        const key = selected ? selected.value : getSavedFilter();  // ← 変更

        if (!cachedRows) cachedRows = document.querySelectorAll('td[data-bind="text: startTime"]');

        let total = 0, visible = 0;
        cachedRows.forEach(td => {
            const row = td.closest('tr');
            if (!row) return;
            total++;
            const cat = getCategory(parseTime(td.textContent));
            if (key === 'ALL' || cat === key) {
                row.classList.remove('rf-hide');
                visible++;
            } else {
                row.classList.add('rf-hide');
            }
        });

        const cnt = document.getElementById('rf-count');
        if (cnt) cnt.textContent = '表示: ' + visible + ' / ' + total;
    }

    function createPanel() {
        if (document.getElementById('rf-panel')) return;

        const savedKey = getSavedFilter();  // ← 追加：保存値を取得

        const panel = document.createElement('div');
        panel.id = 'rf-panel';

        let html = '<div id="rf-header"><span>Filter</span><button id="rf-toggle">-</button></div>';
        html += '<div id="rf-content">';
        FILTERS.forEach(f => {
            // ← 変更：保存値と一致するものをチェック
            const checked = f.key === savedKey ? ' checked' : '';
            html += '<label><input type="radio" name="rf-filter" value="' + f.key + '"' + checked + '>' + f.label + '</label>';
        });
        html += '<button id="rf-refresh">更新</button>';
        html += '<div id="rf-count">-</div>';
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);

        // ← 変更：changeイベントで保存も実行
        panel.addEventListener('change', function(e) {
            if (e.target.name === 'rf-filter') {
                saveFilter(e.target.value);  // ← 追加：選択を保存
            }
            doFilter();
        });

        document.getElementById('rf-toggle').onclick = function() {
            const content = document.getElementById('rf-content');
            if (content.classList.contains('hide')) {
                content.classList.remove('hide');
                this.textContent = '-';
            } else {
                content.classList.add('hide');
                this.textContent = '+';
            }
        };

        document.getElementById('rf-refresh').onclick = function() {
            cachedRows = null;
            doFilter();
        };
    }

    setTimeout(function() {
        createPanel();
        doFilter();
    }, 3000);

})();
