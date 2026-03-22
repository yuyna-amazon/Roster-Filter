// ==UserScript==
// @name         Roster Filter & Highlighter
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      3.0
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @description  Simple roster filter + availability highlighter
// @match        https://logistics.amazon.co.jp/internal/capacity/rosterview*
// @updateURL    https://raw.githubusercontent.com/yuyna-amazon/Roster-Filter/main/Roster-Filter.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyna-amazon/Roster-Filter/main/Roster-Filter.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /* ======================================================
       共通ユーティリティ
    ====================================================== */

    // 時刻文字列 → 分数 (0–1439)
    function parseTimeToMinutes(str) {
        if (!str) return null;
        const m = str.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const p = m[3].toLowerCase();
        if (p === 'am' && h === 12) h = 0;
        if (p === 'pm' && h !== 12) h += 12;
        return h * 60 + min;
    }

    // 時刻文字列 → 今日の Date オブジェクト
    function parseTimeToDate(str) {
        const mins = parseTimeToMinutes(str);
        if (mins === null) return null;
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                        Math.floor(mins / 60), mins % 60, 0);
    }

    /* ======================================================
       Filter — 定数・状態
    ====================================================== */

    const STORAGE_KEY = 'rf-selected-filter';

    const FILTERS = [
        { key: 'ALL',    label: '全て表示', min: -1,   max: -1 },
        { key: 'SSD_1',  label: 'SSD_1',    min: 0,    max: 420 },
        { key: 'SSD_1_B',label: 'SSD_1_B',  min: 420,  max: 600 },
        { key: 'SSD_2',  label: 'SSD_2',    min: 600,  max: 840 },
        { key: 'SSD_3',  label: 'SSD_3',    min: 840,  max: 1020 },
        { key: 'SSD_3_B',label: 'SSD_3_B',  min: 1020, max: 1200 },
        { key: 'SSD_4',  label: 'SSD_4',    min: 1200, max: Infinity }
    ];

    const EXCLUDED_TYPES = ['AmFlex Kei Van (ProDP)'];

    let cachedRows = null;

    /* ======================================================
       Highlighter — 定数
    ====================================================== */

    const ACTIVE_COLOR = '#ffffcc';   // 実行中: 薄い黄色

    /* ======================================================
       CSS
    ====================================================== */

    const style = document.createElement('style');
    style.textContent = `
        #rf-panel{position:fixed;top:55px;right:10px;background:#fff;border:2px solid #232f3e;
                  border-radius:6px;padding:10px;z-index:10000;
                  box-shadow:0 2px 8px rgba(0,0,0,0.2);font:12px Arial,sans-serif;min-width:120px}
        #rf-header{display:flex;justify-content:space-between;align-items:center;
                   margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid #ff9900}
        #rf-header span{font-weight:bold;font-size:13px}
        #rf-toggle{background:none;border:none;font-size:16px;cursor:pointer;padding:0 4px}
        #rf-content{display:block}
        #rf-content.hide{display:none}
        #rf-panel label{display:block;margin:4px 0;cursor:pointer}
        #rf-panel input{margin-right:6px}
        #rf-count{margin-top:8px;padding:6px;background:#f5f5f5;border-radius:3px}
        #rf-refresh{padding:4px 8px;margin-top:8px;cursor:pointer;
                    border:1px solid #232f3e;border-radius:3px;font-size:11px;width:100%}
        .rf-hide{display:none!important}
    `;
    document.head.appendChild(style);

    /* ======================================================
       Filter — ロジック
    ====================================================== */

    function getSavedFilter() {
        return localStorage.getItem(STORAGE_KEY) || 'ALL';
    }

    function saveFilter(key) {
        localStorage.setItem(STORAGE_KEY, key);
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
        const key = selected ? selected.value : getSavedFilter();

        if (!cachedRows) cachedRows = document.querySelectorAll('td[data-bind="text: startTime"]');

        let total = 0, visible = 0;
        cachedRows.forEach(td => {
            const row = td.closest('tr');
            if (!row) return;
            total++;

            const stTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            const isExcluded = stTd && EXCLUDED_TYPES.includes(stTd.textContent.trim());

            const cat = getCategory(parseTimeToMinutes(td.textContent));

            if (key === 'ALL') {
                row.classList.remove('rf-hide');
                visible++;
            } else if (isExcluded) {
                row.classList.add('rf-hide');
            } else if (cat === key) {
                row.classList.remove('rf-hide');
                visible++;
            } else {
                row.classList.add('rf-hide');
            }
        });

        const cnt = document.getElementById('rf-count');
        if (cnt) cnt.textContent = '表示: ' + visible + ' / ' + total;
    }

    /* ======================================================
       Highlighter — ロジック
    ====================================================== */

    function highlightRows() {
        const rows = document.querySelectorAll('tr[data-bind="visible: isVisible"]');
        const now = new Date();

        rows.forEach(tr => {
            const availabilityTd = tr.querySelector('td[data-bind="text: availability"]');
            const endTimeTd      = tr.querySelector('td[data-bind="text: endTime"]');
            if (!availabilityTd) return;

            const availability = availabilityTd.textContent.trim();
            const endTime      = parseTimeToDate(endTimeTd ? endTimeTd.textContent.trim() : null);

            tr.style.backgroundColor = '';

            // 終了時刻が過ぎている → 色なし
            if (endTime && endTime < now) return;

            if (availability === '実行中') {
                tr.style.backgroundColor = ACTIVE_COLOR;
            }
        });
    }

    /* ======================================================
       UI パネル
    ====================================================== */

    function createPanel() {
        if (document.getElementById('rf-panel')) return;

        const savedKey = getSavedFilter();
        const panel = document.createElement('div');
        panel.id = 'rf-panel';

        let html = '<div id="rf-header"><span>Filter</span><button id="rf-toggle">-</button></div>';
        html += '<div id="rf-content">';
        FILTERS.forEach(f => {
            const checked = f.key === savedKey ? ' checked' : '';
            html += '<label><input type="radio" name="rf-filter" value="' +
                     f.key + '"' + checked + '>' + f.label + '</label>';
        });
        html += '<button id="rf-refresh">更新</button>';
        html += '<div id="rf-count">-</div>';
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);

        // フィルター変更
        panel.addEventListener('change', function(e) {
            if (e.target.name === 'rf-filter') saveFilter(e.target.value);
            doFilter();
        });

        // パネル折りたたみ
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

        // 更新ボタン（Filter + Highlighter 両方再実行）
        document.getElementById('rf-refresh').onclick = function() {
            cachedRows = null;
            doFilter();
            highlightRows();
        };
    }

    /* ======================================================
       初期化
    ====================================================== */

    // メイン初期化（3 秒後）
    setTimeout(function() {
        createPanel();
        doFilter();
        highlightRows();
    }, 3000);

    // Highlighter: DOM 変更を監視して自動ハイライト
    const observer = new MutationObserver(highlightRows);
    if (document.body) {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // Highlighter: 1 分ごとに再評価（終了時刻の経過判定用）
    setInterval(highlightRows, 60000);

})();
