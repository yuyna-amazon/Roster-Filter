// ==UserScript==
// @name         Roster view
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      4.0
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @description  Simple roster filter + availability highlighter + copy table data + block counter
// @match        https://logistics.amazon.co.jp/internal/capacity/rosterview*
// @updateURL    https://raw.githubusercontent.com/yuyna-amazon/Roster-Filter/main/Roster-Filter.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyna-amazon/Roster-Filter/main/Roster-Filter.user.js
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    /* ======================================================
       共通ユーティリティ
    ====================================================== */

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

    const ACTIVE_COLOR = '#ffffcc';

    /* ======================================================
       CSS
    ====================================================== */

    const style = document.createElement('style');
    style.textContent = `
        #rf-panel{position:fixed;top:5px;right:10px;background:#fff;border:2px solid #232f3e;
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
        #rf-btn-group{display:flex;flex-direction:column;gap:4px;margin-top:8px}
        .rf-btn{padding:4px 8px;cursor:pointer;border-radius:3px;font-size:11px;width:100%;
                border:1px solid #232f3e;background:#fff;color:#232f3e}
        .rf-btn:hover{background:#f0f0f0}
        .rf-btn-green{border:none;background-color:#4CAF50;color:white}
        .rf-btn-green:hover{background-color:#45a049}
        .rf-hide{display:none!important}
        .rf-notification{position:fixed;top:50px;right:150px;padding:10px 15px;
                         background-color:#4CAF50;color:white;border-radius:5px;
                         z-index:10001;font:12px Arial,sans-serif;
                         box-shadow:0 2px 8px rgba(0,0,0,0.2)}

        /* Block Counter Box */
        #rf-block-box{position:fixed;bottom:20px;right:20px;padding:15px 20px;
                      background:#ffffff;color:#333;border:2px solid #2196F3;border-radius:8px;
                      box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:9999;
                      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
                      font-size:14px;width:400px;max-height:500px;overflow-y:auto}
        #rf-block-box.error{border-color:#f44336}
        .rf-block-header{background:#fff3e0;padding:10px;border-radius:5px;margin-bottom:10px}
        .rf-block-row{display:flex;justify-content:space-between;margin:5px 0}
        .rf-block-title{font-weight:bold;margin-bottom:8px;color:#2196F3}
        .rf-block-item{display:grid;grid-template-columns:100px 60px 1fr;gap:10px;
                       margin:3px 0;padding:8px;background:#f5f5f5;border-radius:3px;align-items:center}
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

            if (endTime && endTime < now) return;

            if (availability === '実行中') {
                tr.style.backgroundColor = ACTIVE_COLOR;
            }
        });
    }

    /* ======================================================
       Copy — ロジック
    ====================================================== */

    function showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'rf-notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.remove();
        }, 3000);
    }

    function copyTableData() {
        const table = document.getElementById('cspDATable');
        if (!table) {
            alert('Table not found!');
            return;
        }

        let data = [];

        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        data.push(headers.join('\t'));

        const rows = table.querySelectorAll('tbody tr');
        let copiedCount = 0;
        rows.forEach(row => {
            if (row.classList.contains('rf-hide')) return;

            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            if (cells.length > 0) {
                data.push(cells.join('\t'));
                copiedCount++;
            }
        });

        const textData = data.join('\n');

        GM_setClipboard(textData);

        showNotification(copiedCount + '行をコピーしました');
    }

    /* ======================================================
       Block Counter — ロジック
    ====================================================== */

    function calculateBlocks() {
        const table = document.getElementById('cspDATable');
        if (!table) {
            showBlockError('テーブルが見つかりません');
            return;
        }

        const headers = table.querySelectorAll('th');
        let timeColumnIndex = -1;
        let durationColumnIndex = -1;

        headers.forEach((th, index) => {
            const headerText = th.textContent.trim();
            if (headerText === '開始時刻' || headerText.includes('開始時刻')) {
                timeColumnIndex = index;
            }
            if (headerText === 'シフトの長さ' || headerText.includes('シフトの長さ')) {
                durationColumnIndex = index;
            }
        });

        if (timeColumnIndex === -1) {
            showBlockError('「開始時刻」列が見つかりません');
            return;
        }

        const rows = table.querySelectorAll('tbody tr');
        let timeFormatData = {};
        let emptyCount = 0;

        rows.forEach((row) => {
            if (row.classList.contains('rf-hide')) return;

            const cells = row.querySelectorAll('td');
            if (cells[timeColumnIndex]) {
                const cellText = cells[timeColumnIndex].textContent.trim();

                if (!cellText || cellText === '') {
                    emptyCount++;
                    return;
                }

                if (cellText.includes(':')) {
                    let duration = '';
                    if (durationColumnIndex !== -1 && cells[durationColumnIndex]) {
                        duration = cells[durationColumnIndex].textContent.trim();
                    }

                    if (timeFormatData[cellText]) {
                        timeFormatData[cellText].count++;
                        if (duration && !timeFormatData[cellText].durations.includes(duration)) {
                            timeFormatData[cellText].durations.push(duration);
                        }
                    } else {
                        timeFormatData[cellText] = {
                            count: 1,
                            durations: duration ? [duration] : []
                        };
                    }
                }
            }
        });

        showBlockResult(timeFormatData, emptyCount, durationColumnIndex !== -1);
    }

    function showBlockError(message) {
        removeBlockBox();

        const box = document.createElement('div');
        box.id = 'rf-block-box';
        box.className = 'error';

        box.innerHTML = `
            <div style="font-weight: bold; color: #f44336;">エラー</div>
            <div style="margin-top: 5px;">${message}</div>
        `;

        document.body.appendChild(box);
    }

    function showBlockResult(timeFormatData, emptyCount, hasDurationColumn) {
        removeBlockBox();

        const box = document.createElement('div');
        box.id = 'rf-block-box';

        let timeFormatsHtml = '';
        const timeFormats = Object.entries(timeFormatData);

        if (timeFormats.length > 0) {
            timeFormats.sort((a, b) => (parseTimeToMinutes(a[0]) || 0) - (parseTimeToMinutes(b[0]) || 0));

            timeFormatsHtml = timeFormats.map(([time, data]) => {
                const durationsText = data.durations.length > 0
                    ? data.durations.join(', ')
                    : '-';

                return `<div class="rf-block-item">
                    <span style="font-weight: bold;">${time}</span>
                    <span style="color: #f44336; font-weight: bold;">${data.count}名</span>
                    <span style="color: #666;">${durationsText}</span>
                </div>`;
            }).join('');
        }

        const totalTimeCount = Object.values(timeFormatData).reduce((sum, data) => sum + data.count, 0);

        const selectedFilter = document.querySelector('#rf-panel input:checked');
        const filterName = selectedFilter ? selectedFilter.value : 'ALL';
        const filterLabel = filterName === 'ALL' ? '全て' : filterName;

        box.innerHTML = `
            <div class="rf-block-header">
                <div style="font-size: 12px; color: #666; margin-bottom: 5px;">フィルター: ${filterLabel}</div>
                <div class="rf-block-row">
                    <span>DP合計:</span>
                    <strong style="color: #f57c00;">${totalTimeCount}名</strong>
                </div>
                ${emptyCount > 0 ? `
                <div class="rf-block-row">
                    <span>空白:</span>
                    <strong style="color: #757575;">${emptyCount}名</strong>
                </div>` : ''}
                ${!hasDurationColumn ? `
                <div style="margin-top: 5px; font-size: 12px; color: #ff9800;">
                    シフトの長さ列が見つかりません
                </div>` : ''}
            </div>

            <div class="rf-block-title">Blockの内訳</div>
            ${timeFormatsHtml || '<div style="color:#999">データがありません</div>'}
        `;

        document.body.appendChild(box);
    }

    function removeBlockBox() {
        const existing = document.getElementById('rf-block-box');
        if (existing) existing.remove();
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
        html += '<div id="rf-btn-group">';
        html += '<button id="rf-refresh" class="rf-btn">更新</button>';
        html += '<button id="rf-copy" class="rf-btn rf-btn-green">Copy</button>';
        html += '</div>';
        html += '<div id="rf-count">-</div>';
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);

        // フィルター変更
        panel.addEventListener('change', function(e) {
            if (e.target.name === 'rf-filter') saveFilter(e.target.value);
            doFilter();
            calculateBlocks();
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

        // 更新ボタン（Filter + Highlighter + Block計算）
        document.getElementById('rf-refresh').onclick = function() {
            cachedRows = null;
            doFilter();
            highlightRows();
            calculateBlocks();
        };

        // コピーボタン
        document.getElementById('rf-copy').onclick = copyTableData;
    }

    /* ======================================================
       初期化
    ====================================================== */

    setTimeout(function() {
        createPanel();
        doFilter();
        highlightRows();
        calculateBlocks();
    }, 3000);

    const observer = new MutationObserver(highlightRows);
    if (document.body) {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    setInterval(highlightRows, 60000);

})();
