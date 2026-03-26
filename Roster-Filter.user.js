// ==UserScript==
// @name         Roster view
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      5.0
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @description  Simple roster filter + availability highlighter + copy table data + block counter + duplicate checker
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

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

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
       定数
    ====================================================== */

    const STORAGE_KEY = 'rf-selected-filter';
    const BATCH_SIZE = 50;

    const FILTERS = [
        { key: 'ALL',    label: '全て表示', min: -1,   max: -1 },
        { key: 'SSD_1',  label: 'SSD_1',    min: 0,    max: 420 },
        { key: 'SSD_1_B',label: 'SSD_1_B',  min: 420,  max: 600 },
        { key: 'SSD_2',  label: 'SSD_2',    min: 600,  max: 840 },
        { key: 'SSD_3',  label: 'SSD_3',    min: 840,  max: 1020 },
        { key: 'SSD_3_B',label: 'SSD_3_B',  min: 1020, max: 1200 },
        { key: 'SSD_4',  label: 'SSD_4',    min: 1200, max: Infinity }
    ];

    const FILTER_INDEX = {};
    FILTERS.forEach((f, i) => { FILTER_INDEX[f.key] = i; });

    const EXCLUDED_TYPES = ['AmFlex Kei Van (ProDP)'];
    const ACTIVE_COLOR = '#ffffcc';
    const DUPLICATE_COLOR = '#ffcccc';

    /* ======================================================
       状態管理
    ====================================================== */

    const cycleNamesCache = {};
    let previousCycleNames = new Set();
    let previousCycleKey = null;
    let isProcessing = false;

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
        #rf-dup-count{margin-top:4px;padding:6px;background:#ffeeee;border-radius:3px;color:#c00;font-size:11px}
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
        #rf-legend{margin-top:8px;padding:6px;background:#fafafa;border-radius:3px;font-size:10px}
        .rf-legend-item{display:flex;align-items:center;margin:2px 0}
        .rf-legend-color{width:14px;height:14px;border-radius:2px;margin-right:6px;border:1px solid #ccc}
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

    function getTable() {
        return document.getElementById('cspDATable');
    }

    function getRows() {
        const table = getTable();
        return table ? table.querySelectorAll('tbody tr') : [];
    }

    function getPreviousCycleKey(currentKey) {
        const currentIndex = FILTER_INDEX[currentKey];
        if (currentIndex <= 1) return null;
        return FILTERS[currentIndex - 1].key;
    }

    function doFilter() {
        const selected = document.querySelector('#rf-panel input:checked');
        const key = selected ? selected.value : getSavedFilter();
        const rows = getRows();

        let total = 0, visible = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const startTimeTd = row.querySelector('td[data-bind="text: startTime"]');
            if (!startTimeTd) continue;

            total++;

            const serviceTypeTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            const isExcluded = serviceTypeTd && EXCLUDED_TYPES.includes(serviceTypeTd.textContent.trim());
            const cat = getCategory(parseTimeToMinutes(startTimeTd.textContent));

            let shouldShow = key === 'ALL' || (!isExcluded && cat === key);

            if (shouldShow) {
                row.classList.remove('rf-hide');
                visible++;
            } else {
                row.classList.add('rf-hide');
            }
        }

        const cnt = document.getElementById('rf-count');
        if (cnt) cnt.textContent = '表示: ' + visible + ' / ' + total;
    }

    /* ======================================================
       サイクルの名前キャッシュ管理
    ====================================================== */

    function cacheNamesForFilter(filterKey) {
        if (filterKey === 'ALL') return;

        const rows = getRows();
        const names = new Set();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const startTimeTd = row.querySelector('td[data-bind="text: startTime"]');
            if (!startTimeTd) continue;

            const serviceTypeTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            const isExcluded = serviceTypeTd && EXCLUDED_TYPES.includes(serviceTypeTd.textContent.trim());
            if (isExcluded) continue;

            const cat = getCategory(parseTimeToMinutes(startTimeTd.textContent));
            if (cat !== filterKey) continue;

            const nameTd = row.querySelector('td[data-bind="text: DAName"]');
            if (nameTd) {
                const name = nameTd.textContent.trim();
                if (name) names.add(name);
            }
        }

        cycleNamesCache[filterKey] = names;
    }

    function cacheAllCycleNames() {
        for (const f of FILTERS) {
            if (f.key !== 'ALL') {
                cacheNamesForFilter(f.key);
            }
        }
    }

    function setPreviousCycleNames(currentKey) {
        const prevKey = getPreviousCycleKey(currentKey);
        previousCycleKey = prevKey;

        if (!prevKey || !cycleNamesCache[prevKey]) {
            previousCycleNames = new Set();
            return;
        }

        previousCycleNames = cycleNamesCache[prevKey];
    }

    /* ======================================================
       Highlighter — バッチ処理版
    ====================================================== */

    function highlightRows() {
        if (isProcessing) return;
        isProcessing = true;

        const rows = Array.from(getRows());
        const now = new Date();
        const selectedFilter = document.querySelector('#rf-panel input:checked');
        const currentKey = selectedFilter ? selectedFilter.value : 'ALL';
        const checkDuplicates = currentKey !== 'ALL' && previousCycleNames.size > 0;

        let duplicateCount = 0;
        let index = 0;

        function processBatch() {
            const end = Math.min(index + BATCH_SIZE, rows.length);

            for (; index < end; index++) {
                const row = rows[index];

                if (row.classList.contains('rf-hide')) {
                    row.style.backgroundColor = '';
                    continue;
                }

                const availabilityTd = row.querySelector('td[data-bind="text: availability"]');
                const endTimeTd = row.querySelector('td[data-bind="text: endTime"]');
                const nameTd = row.querySelector('td[data-bind="text: DAName"]');

                const availability = availabilityTd ? availabilityTd.textContent.trim() : '';
                const endTime = parseTimeToDate(endTimeTd ? endTimeTd.textContent.trim() : null);
                const name = nameTd ? nameTd.textContent.trim() : '';

                let newColor = '';

                if (!endTime || endTime >= now) {
                    if (availability === '実行中') {
                        newColor = ACTIVE_COLOR;
                    } else if (checkDuplicates && name && previousCycleNames.has(name)) {
                        newColor = DUPLICATE_COLOR;
                        duplicateCount++;
                    }
                }

                row.style.backgroundColor = newColor;
            }

            if (index < rows.length) {
                setTimeout(processBatch, 0);
            } else {
                updateDuplicateCount(duplicateCount, currentKey);
                isProcessing = false;
            }
        }

        processBatch();
    }

    function updateDuplicateCount(count, currentKey) {
        let dupDiv = document.getElementById('rf-dup-count');

        if (currentKey === 'ALL' || !previousCycleKey) {
            if (dupDiv) dupDiv.style.display = 'none';
            return;
        }

        if (!dupDiv) {
            dupDiv = document.createElement('div');
            dupDiv.id = 'rf-dup-count';
            const countDiv = document.getElementById('rf-count');
            if (countDiv) countDiv.after(dupDiv);
        }

        dupDiv.style.display = 'block';
        dupDiv.innerHTML = `${previousCycleKey}から重複: <strong>${count}名</strong>`;
    }

    /* ======================================================
       Copy — ロジック
    ====================================================== */

    function showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'rf-notification';
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    function copyTableData() {
        const table = getTable();
        if (!table) {
            alert('Table not found!');
            return;
        }

        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        const data = [headers.join('\t')];

        let copiedCount = 0;
        const rows = table.querySelectorAll('tbody tr');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.classList.contains('rf-hide')) continue;
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            if (cells.length > 0) {
                data.push(cells.join('\t'));
                copiedCount++;
            }
        }

        GM_setClipboard(data.join('\n'));
        showNotification(copiedCount + '行をコピーしました');
    }

    /* ======================================================
       Block Counter — ロジック
    ====================================================== */

    function calculateBlocks() {
        const table = getTable();
        if (!table) {
            showBlockError('テーブルが見つかりません');
            return;
        }

        const headers = table.querySelectorAll('th');
        let timeColumnIndex = -1;
        let durationColumnIndex = -1;

        for (let i = 0; i < headers.length; i++) {
            const headerText = headers[i].textContent.trim();
            if (headerText.includes('開始時刻')) timeColumnIndex = i;
            if (headerText.includes('シフトの長さ')) durationColumnIndex = i;
        }

        if (timeColumnIndex === -1) {
            showBlockError('「開始時刻」列が見つかりません');
            return;
        }

        const timeFormatData = {};

        const rows = table.querySelectorAll('tbody tr');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.classList.contains('rf-hide')) continue;

            const cells = row.querySelectorAll('td');
            const cellText = cells[timeColumnIndex] ? cells[timeColumnIndex].textContent.trim() : '';

            // 時刻形式のみカウント（空白や無効な形式はスキップ）
            if (!cellText || !cellText.includes(':')) continue;

            const duration = durationColumnIndex !== -1 && cells[durationColumnIndex]
                ? cells[durationColumnIndex].textContent.trim()
                : '';

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

        showBlockResult(timeFormatData, durationColumnIndex !== -1);
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

    function showBlockResult(timeFormatData, hasDurationColumn) {
        removeBlockBox();

        const box = document.createElement('div');
        box.id = 'rf-block-box';

        const timeFormats = Object.entries(timeFormatData);
        timeFormats.sort((a, b) => (parseTimeToMinutes(a[0]) || 0) - (parseTimeToMinutes(b[0]) || 0));

        const timeFormatsHtml = timeFormats.length > 0
            ? timeFormats.map(([time, data]) => `
                <div class="rf-block-item">
                    <span style="font-weight: bold;">${time}</span>
                    <span style="color: #f44336; font-weight: bold;">${data.count}名</span>
                    <span style="color: #666;">${data.durations.join(', ') || '-'}</span>
                </div>`).join('')
            : '<div style="color:#999">データがありません</div>';

        const totalTimeCount = Object.values(timeFormatData).reduce((sum, data) => sum + data.count, 0);
        const selectedFilter = document.querySelector('#rf-panel input:checked');
        const filterLabel = selectedFilter?.value === 'ALL' ? '全て' : (selectedFilter?.value || 'ALL');

        box.innerHTML = `
            <div class="rf-block-header">
                <div style="font-size: 12px; color: #666; margin-bottom: 5px;">フィルター: ${filterLabel}</div>
                <div class="rf-block-row">
                    <span>DP合計:</span>
                    <strong style="color: #f57c00;">${totalTimeCount}名</strong>
                </div>
                ${!hasDurationColumn ? `<div style="margin-top: 5px; font-size: 12px; color: #ff9800;">シフトの長さ列が見つかりません</div>` : ''}
            </div>
            <div class="rf-block-title">Blockの内訳</div>
            ${timeFormatsHtml}
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

        panel.innerHTML = `
            <div id="rf-header"><span>Filter</span><button id="rf-toggle">-</button></div>
            <div id="rf-content">
                ${FILTERS.map(f => `
                    <label><input type="radio" name="rf-filter" value="${f.key}"${f.key === savedKey ? ' checked' : ''}>${f.label}</label>
                `).join('')}
                <div id="rf-btn-group">
                    <button id="rf-refresh" class="rf-btn">更新</button>
                    <button id="rf-copy" class="rf-btn rf-btn-green">Copy</button>
                </div>
                <div id="rf-count">-</div>
                <div id="rf-legend">
                    <div class="rf-legend-item"><div class="rf-legend-color" style="background:${ACTIVE_COLOR}"></div>実行中</div>
                    <div class="rf-legend-item"><div class="rf-legend-color" style="background:${DUPLICATE_COLOR}"></div>前Cycle重複</div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        panel.addEventListener('change', function(e) {
            if (e.target.name === 'rf-filter') {
                const newKey = e.target.value;
                saveFilter(newKey);
                setPreviousCycleNames(newKey);
                doFilter();
                highlightRows();
                calculateBlocks();
            }
        });

        document.getElementById('rf-toggle').onclick = function() {
            const content = document.getElementById('rf-content');
            const isHidden = content.classList.toggle('hide');
            this.textContent = isHidden ? '+' : '-';
        };

        document.getElementById('rf-refresh').onclick = function() {
            cacheAllCycleNames();
            const selected = document.querySelector('#rf-panel input:checked');
            const currentKey = selected ? selected.value : 'ALL';
            setPreviousCycleNames(currentKey);
            doFilter();
            highlightRows();
            calculateBlocks();
        };

        document.getElementById('rf-copy').onclick = copyTableData;
    }

    /* ======================================================
       初期化
    ====================================================== */

    function init() {
        createPanel();
        cacheAllCycleNames();
        const savedKey = getSavedFilter();
        setPreviousCycleNames(savedKey);
        doFilter();
        highlightRows();
        calculateBlocks();
    }

    function waitForTable() {
        const table = getTable();
        if (table && table.querySelector('tbody tr')) {
            init();
        } else {
            setTimeout(waitForTable, 1000);
        }
    }

    setTimeout(waitForTable, 2000);

})();
