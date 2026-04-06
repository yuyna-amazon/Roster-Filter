// ==UserScript==
// @name         Roster view
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      6.0
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @description  Simple roster filter + availability highlighter + copy table data + block counter + duplicate checker + next cycle info inside body cells
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
        const text = str.trim();

        let m = text.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
        if (m) {
            let h = parseInt(m[1], 10);
            const min = parseInt(m[2], 10);
            const p = m[3].toLowerCase();

            if (p === 'am' && h === 12) h = 0;
            if (p === 'pm' && h !== 12) h += 12;
            return h * 60 + min;
        }

        m = text.match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
            const h = parseInt(m[1], 10);
            const min = parseInt(m[2], 10);
            return h * 60 + min;
        }

        return null;
    }

    function parseTimeToDate(str) {
        const mins = parseTimeToMinutes(str);
        if (mins === null) return null;

        const now = new Date();
        return new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            Math.floor(mins / 60),
            mins % 60,
            0
        );
    }

    function minutesToDisplayTime(mins) {
        if (mins === null || mins === undefined) return '-';
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const period = h >= 12 ? 'pm' : 'am';
        let dispH = h % 12;
        if (dispH === 0) dispH = 12;
        return String(dispH) + ':' + (m < 10 ? '0' + m : String(m)) + ' ' + period;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ======================================================
       定数
    ====================================================== */

    const STORAGE_KEY = 'rf-selected-filter';
    const BATCH_SIZE  = 50;

    const FILTERS = [
        { key: 'ALL',     label: '全て表示', min: -1,   max: -1 },
        { key: 'SSD_1',   label: 'SSD_1',    min: 0,    max: 420 },
        { key: 'SSD_1_B', label: 'SSD_1_B',  min: 420,  max: 600 },
        { key: 'SSD_2',   label: 'SSD_2',    min: 600,  max: 840 },
        { key: 'SSD_3',   label: 'SSD_3',    min: 840,  max: 1020 },
        { key: 'SSD_3_B', label: 'SSD_3_B',  min: 1020, max: 1200 },
        { key: 'SSD_4',   label: 'SSD_4',    min: 1200, max: Infinity }
    ];

    const FILTER_INDEX = {};
    FILTERS.forEach((f, i) => {
        FILTER_INDEX[f.key] = i;
    });

    const EXCLUDED_TYPES  = ['AmFlex Kei Van (ProDP)'];
    const ACTIVE_COLOR    = '#ffffcc';
    const DUPLICATE_COLOR = '#ffcccc';

    /* ======================================================
       状態管理
    ====================================================== */

    const cycleNamesCache = {};
    const cycleDetailCache = {};
    let nextCycleNames = new Set();
    let nextCycleKey   = null;
    let isProcessing   = false;
    let observer       = null;

    /* ======================================================
       CSS
    ====================================================== */

    const style = document.createElement('style');
    style.textContent = `
        #rf-panel {
            position: fixed;
            top: 5px;
            right: 10px;
            background: #fff;
            border: 2px solid #000;
            border-radius: 6px;
            padding: 10px;
            z-index: 10000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            font: 12px Arial, sans-serif;
            max-height: 92vh;
            overflow-y: auto;
        }
        #rf-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 2px solid #ff9900;
        }
        #rf-header span { font-weight: bold; font-size: 13px; }
        #rf-toggle {
            background: none;
            border: none;
            font-size: 16px;
            cursor: pointer;
            padding: 0 4px;
        }

        #rf-content {
            display: flex;
            flex-direction: row;
            align-items: flex-start;
        }
        #rf-content.hide { display: none; }

        #rf-left {
            min-width: 130px;
            flex-shrink: 0;
            padding-right: 10px;
        }
        #rf-vdivider {
            width: 1px;
            background: #ddd;
            align-self: stretch;
            flex-shrink: 0;
        }
        #rf-right {
            min-width: 240px;
            flex: 1;
            padding-left: 10px;
        }

        #rf-panel label {
            display: block;
            margin: 4px 0;
            cursor: pointer;
        }
        #rf-panel input[type="radio"] {
            margin-right: 6px;
        }

        #rf-count {
            margin-top: 8px;
            padding: 6px;
            background: #f5f5f5;
            border-radius: 3px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-sizing: border-box;
            width: 100%;
            font-size: 12px;
        }
        #rf-count .rf-count-label { text-align: left; }
        #rf-count .rf-count-val { text-align: right; }
        #rf-dup-count {
            margin-top: 4px;
            padding: 6px;
            background: #ffeeee;
            border-radius: 3px;
            color: #c00;
            font-size: 11px;
            line-height: 1.2;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            box-sizing: border-box;
            width: 100%;
        }
        #rf-dup-count .rf-dup-key { text-align: left; }
        #rf-dup-count .rf-dup-val { text-align: right; }

        #rf-btn-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 8px;
        }

        .rf-btn {
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 11px;
            width: 100%;
            border: 1px solid #232f3e;
            background: #fff;
            color: #232f3e;
        }
        .rf-btn:hover { background: #f0f0f0; }

        .rf-btn-green {
            border: none;
            background-color: #4CAF50;
            color: white;
        }
        .rf-btn-green:hover { background-color: #45a049; }

        #rf-legend {
            margin-top: 8px;
            padding: 6px;
            background: #fafafa;
            border-radius: 3px;
            font-size: 10px;
        }
        .rf-legend-item {
            display: flex;
            align-items: center;
            margin: 2px 0;
        }
        .rf-legend-color {
            width: 14px;
            height: 14px;
            border-radius: 2px;
            margin-right: 6px;
            border: 1px solid #ccc;
        }

        .rf-block-header {
            background: #fff3e0;
            padding: 10px;
            border-radius: 5px;
            margin-bottom: 10px;
        }
        .rf-block-row {
            display: flex;
            justify-content: space-between;
            margin: 5px 0;
        }
        .rf-block-title {
            font-weight: bold;
            margin-bottom: 8px;
            color: #2196F3;
        }
        .rf-block-item {
            display: grid;
            grid-template-columns: 100px 60px 1fr;
            gap: 10px;
            margin: 3px 0;
            padding: 8px;
            background: #f5f5f5;
            border-radius: 3px;
            align-items: center;
        }
        .rf-block-error {
            border-color: #f44336;
            color: #f44336;
        }

        .rf-hide { display: none !important; }

        .rf-notification {
            position: fixed;
            top: 50px;
            right: 150px;
            padding: 10px 15px;
            background-color: #4CAF50;
            color: white;
            border-radius: 5px;
            z-index: 10001;
            font: 12px Arial, sans-serif;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }

        .rf-start-base {
            display: inline-block;
            position: relative;
            max-width: 100%;
            box-sizing: border-box;
        }
        .rf-start-base .rf-start-base-text {
            display: inline-block;
        }
        .rf-next-cycle-note {
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            top: 100%;
            margin-top: 2px;
            font-size: 10px;
            line-height: 1.1;
            color: #c2185b;
            font-weight: bold;
            white-space: normal;
            background: rgba(255,255,255,0.95);
            padding: 2px 6px;
            border-radius: 3px;
            max-width: calc(100% - 8px);
            box-sizing: border-box;
            overflow-wrap: anywhere;
            word-break: break-word;
            text-align: center;
            z-index: 3;
            pointer-events: none;
            display: block;
        }
        /* インラインで右側に表示する注釈 (横並び) */
        .rf-end-inline {
            /* 表示フローに影響を与えないインラインラッパー
               注釈はセルに対して絶対配置するのでここでは位置を変えない */
            position: static;
            display: inline;
            vertical-align: middle;
        }
        .rf-end-text {
            display: inline-block;
            /* 基本の時刻表示は他の行と揃えるため余白を与えない（位置は変えない） */
            padding-right: 0;
            box-sizing: border-box;
            min-width: 0;
        }
        .rf-next-cycle-inline {
            position: absolute;
            /* ベース文字列の右側に収める（セル内で被らないように少し余裕を持たせる） */
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            line-height: 1;
            color: #c2185b;
            font-weight: bold;
            white-space: nowrap;
            background: transparent;
            padding: 0 2px;
            pointer-events: none;
            z-index: 5;
            max-width: 40px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .rf-next-cycle-inline .rf-next-time {
            display: block;
            font-size: 11px;
            line-height: 1;
            width: 40px;
            max-width: 40px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: center;
        }
        .rf-next-cycle-inline .rf-next-period {
            display: block;
            font-size: 10px;
            line-height: 1;
            color: #c2185b;
            opacity: 0.95;
        }
        /* 別列として挿入するセルのスタイル */
        td.rf-next-cell {
            width: 48px;
            max-width: 48px;
            padding: 2px 4px;
            text-align: center;
            vertical-align: middle;
            font-size: 11px;
            color: #c2185b;
            font-weight: bold;
            background: transparent;
        }
        td.rf-next-cell .rf-next-time { font-size: 12px; }
        td.rf-next-cell .rf-next-period { font-size: 11px; color: #c2185b; opacity: 0.95; }
        /* 行間を広げないため、インナーは詰めて表示 */
        .rf-next-cell-inner {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 0;
            line-height: 1;
            margin: 0;
            padding: 0;
        }
        td.rf-next-cell .rf-next-time,
        td.rf-next-cell .rf-next-period {
            display: block;
            margin: 0;
            padding: 0;
            line-height: 1;
        }
        th.rf-next-header { width: 48px; max-width: 48px; }
    `;
    document.head.appendChild(style);

    /* ======================================================
       Filter
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
            if (f.min === f.max ? min === f.min : min >= f.min && min < f.max) {
                return f.key;
            }
        }
        return null;
    }

    function getTable() {
        return document.getElementById('cspDATable');
    }

    function getRows() {
        const t = getTable();
        return t ? t.querySelectorAll('tbody tr') : [];
    }

    function getNameCell(row) {
        let td = row.querySelector('td[data-bind="text: DAName"]');
        if (td) return td;

        const candidates = row.querySelectorAll('td[data-bind]');
        for (const candidate of candidates) {
            const bind = (candidate.getAttribute('data-bind') || '').toLowerCase();
            if (bind.includes('text:') && bind.includes('name')) {
                if (!bind.includes('servicetypename') && !bind.includes('availability')) {
                    return candidate;
                }
            }
        }
        return null;
    }

    function getStartTimeCell(row) {
        let td = row.querySelector('td[data-bind="text: startTime"]');
        if (td) return td;

        const candidates = row.querySelectorAll('td[data-bind]');
        for (const candidate of candidates) {
            const bind = (candidate.getAttribute('data-bind') || '').toLowerCase();
            if (bind.includes('text:') && bind.includes('start')) {
                return candidate;
            }
        }
        return null;
    }

    function getEndTimeCell(row) {
        let td = row.querySelector('td[data-bind="text: endTime"]');
        if (td) return td;

        const candidates = row.querySelectorAll('td[data-bind]');
        for (const candidate of candidates) {
            const bind = (candidate.getAttribute('data-bind') || '').toLowerCase();
            if (bind.includes('text:') && bind.includes('end')) {
                return candidate;
            }
        }
        return null;
    }

    function normalizeName(name) {
        return String(name || '')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    function getNextCycleKey(currentKey) {
        const idx = FILTER_INDEX[currentKey];
        if (idx === undefined || idx >= FILTERS.length - 1) return null;
        return FILTERS[idx + 1].key;
    }

    function doFilter() {
        const selected = document.querySelector('#rf-panel input:checked');
        const key = selected ? selected.value : getSavedFilter();
        const rows = getRows();

        let total = 0;
        let visible = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const startTimeTd = getStartTimeCell(row);
            if (!startTimeTd) continue;

            total++;

            const serviceTypeTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            const isExcluded = serviceTypeTd && EXCLUDED_TYPES.includes(serviceTypeTd.textContent.trim());
            const cat = getCategory(parseTimeToMinutes(startTimeTd.textContent));
            const shouldShow = key === 'ALL' || (!isExcluded && cat === key);

            if (shouldShow) {
                row.classList.remove('rf-hide');
                visible++;
            } else {
                row.classList.add('rf-hide');
            }
        }

        const cnt = document.getElementById('rf-count');
        if (cnt) cnt.innerHTML = '<span class="rf-count-label">表示</span>'
            + '<span class="rf-count-val">' + visible + ' / ' + total + '</span>';
    }

    /* ======================================================
       次Cycle情報キャッシュ
    ====================================================== */

    function cacheDetailsForFilter(filterKey) {
        if (filterKey === 'ALL') return;

        const rows = getRows();
        const names = new Set();
        const detailMap = new Map();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const startTimeTd = getStartTimeCell(row);
            if (!startTimeTd) continue;

            const serviceTypeTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            if (serviceTypeTd && EXCLUDED_TYPES.includes(serviceTypeTd.textContent.trim())) continue;

            restoreCellHtml(startTimeTd);
            const endTimeTd = getEndTimeCell(row);
            restoreCellHtml(endTimeTd);

            const startText = startTimeTd.textContent.trim();
            const cat = getCategory(parseTimeToMinutes(startText));
            if (cat !== filterKey) continue;

            const nameTd = getNameCell(row);

            const name = nameTd ? nameTd.textContent.trim() : '';
            const normalizedName = normalizeName(name);
            const endText = endTimeTd ? endTimeTd.textContent.trim() : '';

            if (!normalizedName) continue;

            names.add(normalizedName);
            const startMins = parseTimeToMinutes(startText);
            const endMins = parseTimeToMinutes(endText);

            if (!detailMap.has(normalizedName)) {
                detailMap.set(normalizedName, {
                    start: startMins,
                    end: endMins
                });
            } else {
                const cur = detailMap.get(normalizedName);
                if (startMins !== null && (cur.start === null || startMins < cur.start)) {
                    cur.start = startMins;
                }
                if (endMins !== null && (cur.end === null || endMins > cur.end)) {
                    cur.end = endMins;
                }
            }
        }

        cycleNamesCache[filterKey] = names;
        cycleDetailCache[filterKey] = detailMap;
    }

    function cacheAllCycleNames() {
        clearNextCycleInfoFromBody();
        FILTERS.forEach(f => {
            if (f.key !== 'ALL') cacheDetailsForFilter(f.key);
        });
    }

    function setNextCycleNames(currentKey) {
        const nKey = getNextCycleKey(currentKey);
        nextCycleKey = nKey;
        if (!nKey) {
            nextCycleNames = new Set();
            return;
        }

        if (!cycleNamesCache[nKey]) {
            cacheDetailsForFilter(nKey);
        }
        nextCycleNames = cycleNamesCache[nKey] || new Set();
    }

    /* ======================================================
       Bodyセルへ直接表示
    ====================================================== */

    function restoreCellHtml(td) {
        if (!td) return;
        if (td.dataset.rfOriginalHtml !== undefined) {
            td.innerHTML = td.dataset.rfOriginalHtml;
        }
        if (td.dataset.rfOriginalPosition !== undefined) {
            td.style.position = td.dataset.rfOriginalPosition || '';
            delete td.dataset.rfOriginalPosition;
        }
    }

    function rememberOriginalCellHtml(td) {
        if (!td) return;
        if (td.dataset.rfOriginalHtml === undefined) {
            td.dataset.rfOriginalHtml = td.innerHTML;
        }
        if (td.dataset.rfOriginalPosition === undefined) {
            td.dataset.rfOriginalPosition = td.style.position || '';
        }
    }

    function clearNextCycleInfoFromBody() {
        getRows().forEach(row => {
            const startTd = getStartTimeCell(row);
            const endTd   = getEndTimeCell(row);
            restoreCellHtml(startTd);
            restoreCellHtml(endTd);
        });
        // remove any previously inserted next-cycle cells/headers
        const table = getTable();
        if (table) {
            Array.from(table.querySelectorAll('td.rf-next-cell')).forEach(td => td.remove());
            Array.from(table.querySelectorAll('th.rf-next-header')).forEach(th => th.remove());
            try { delete table.dataset.rfNextColIndex; } catch (e) {}
        }
    }

    // NOTE: 列挿入方式は列幅を崩すため廃止しました。
    //       代わりに injectNextCycleInfoIntoBody() で endTd 内に
    //       オーバーレイ表示します（レイアウトを崩しません）。

    function injectNextCycleInfoIntoBody(startTd, endTd, nextInfo) {
        if (!endTd || !nextInfo) return;

        // startTd は表示しない（開始セルには何も注入しない）
        // 終了セルには右側に次Cycleの開始時刻をインラインで表示する
        // 保存（後で復元するため）するが、注釈は innerHTML を置き換えず append する
        rememberOriginalCellHtml(endTd);
        try { endTd.style.position = 'relative'; } catch (e) { /* ignore */ }

        const nextStart = nextInfo.start !== null && nextInfo.start !== undefined
            ? minutesToDisplayTime(nextInfo.start)
            : '-';

        const parts = String(nextStart).split(/\s+/);
        const timePart = parts[0] || nextStart;
        const periodPart = parts[1] || '';

        // 既存のセル内容はそのままに、絶対配置の注釈要素を追加する（列幅を変えない）
        // まず既に挿入済みの注釈があれば削除
        const existing = endTd.querySelector('.rf-next-cycle-inline');
        if (existing) existing.remove();

        const note = document.createElement('span');
        note.className = 'rf-next-cycle-inline';
        note.innerHTML = '<span class="rf-next-time">' + escapeHtml(timePart) + '</span>'
            + (periodPart ? '<span class="rf-next-period">' + escapeHtml(periodPart) + '</span>' : '');
        endTd.appendChild(note);
    }

    /* ======================================================
       Highlighter
    ====================================================== */

    function highlightRows() {
        if (isProcessing) return;
        isProcessing = true;

        clearNextCycleInfoFromBody();

        const rows = Array.from(getRows());
        const now = new Date();

        const selectedFilter = document.querySelector('#rf-panel input:checked');
        const currentKey = selectedFilter ? selectedFilter.value : 'ALL';
        const checkDuplicates = currentKey !== 'ALL' && nextCycleNames.size > 0;
        const nextDetailMap = nextCycleKey && cycleDetailCache[nextCycleKey]
            ? cycleDetailCache[nextCycleKey]
            : new Map();

        let duplicateCount = 0;
        let index = 0;

        function processBatch() {
            const end = Math.min(index + BATCH_SIZE, rows.length);

            for (; index < end; index++) {
                const row = rows[index];
                const nameTd = getNameCell(row);
                const startTd = getStartTimeCell(row);
                const endTd   = getEndTimeCell(row);

                if (row.classList.contains('rf-hide')) {
                    row.style.backgroundColor = '';
                    if (nameTd) {
                        nameTd.style.color = '';
                        nameTd.style.fontWeight = '';
                    }
                    restoreCellHtml(startTd);
                    restoreCellHtml(endTd);
                    continue;
                }

                const availabilityTd = row.querySelector('td[data-bind="text: availability"]');

                const availability = availabilityTd ? availabilityTd.textContent.trim() : '';
                const endTime = parseTimeToDate(endTd ? endTd.textContent.trim() : null);
                const name = nameTd ? nameTd.textContent.trim() : '';
                const normalizedName = normalizeName(name);

                let newColor = '';
                let isActive = false;
                let isDuplicate = false;

                const nextInfo = normalizedName ? nextDetailMap.get(normalizedName) : null;

                isDuplicate = checkDuplicates && !!normalizedName && nextCycleNames.has(normalizedName);
                isActive = (!endTime || endTime >= now) && (availability === '実行中');

                if (isDuplicate) duplicateCount++;

                if (isActive) {
                    newColor = ACTIVE_COLOR;
                } else if (isDuplicate) {
                    newColor = DUPLICATE_COLOR;
                }

                row.style.backgroundColor = newColor;

                if (nameTd) {
                    if (isActive && isDuplicate) {
                        nameTd.style.color = '#c00';
                        nameTd.style.fontWeight = 'bold';
                    } else {
                        nameTd.style.color = '';
                        nameTd.style.fontWeight = '';
                    }
                }

                if (isDuplicate && nextInfo) {
                    // endTd 内にオーバーレイ注釈を表示（列幅は変えない）
                    injectNextCycleInfoIntoBody(startTd, endTd, nextInfo);
                } else {
                    restoreCellHtml(startTd);
                    restoreCellHtml(endTd);
                }
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

        if (currentKey === 'ALL' || !nextCycleKey) {
            if (dupDiv) dupDiv.style.display = 'none';
            return;
        }

        if (!dupDiv) {
            dupDiv = document.createElement('div');
            dupDiv.id = 'rf-dup-count';
            const countDiv = document.getElementById('rf-count');
            if (countDiv) countDiv.after(dupDiv);
        }

        dupDiv.style.display = 'flex';
        dupDiv.innerHTML = '<span class="rf-dup-key"><strong>' + nextCycleKey + '</strong></span>'
            + '<span class="rf-dup-val">重複: <strong>' + count + '名</strong></span>';
    }

    /* ======================================================
       Copy
    ====================================================== */

    function showNotification(message) {
        const n = document.createElement('div');
        n.className = 'rf-notification';
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3000);
    }

    function getCellTextForCopy(td) {
        if (!td) return '';
        const note = td.querySelector('.rf-next-cycle-note, .rf-next-cycle-inline');
        if (!note) return td.textContent.trim();
        const full = td.textContent || '';
        const noteText = note.textContent || '';
        return full.replace(noteText, '').trim();
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

        table.querySelectorAll('tbody tr').forEach(row => {
            if (row.classList.contains('rf-hide')) return;
            const cells = Array.from(row.querySelectorAll('td')).map(td => getCellTextForCopy(td));
            if (cells.length > 0) {
                data.push(cells.join('\t'));
                copiedCount++;
            }
        });

        GM_setClipboard(data.join('\n'));
        showNotification(copiedCount + '行をコピーしました');
    }

    /* ======================================================
       Block Counter
    ====================================================== */

    function getBlockSection() {
        return document.getElementById('rf-block-section');
    }

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
            const t = headers[i].textContent.trim();
            if (t.includes('開始時刻')) timeColumnIndex = i;
            if (t.includes('シフトの長さ')) durationColumnIndex = i;
        }

        if (timeColumnIndex === -1) {
            showBlockError('「開始時刻」列が見つかりません');
            return;
        }

        const timeFormatData = {};

        table.querySelectorAll('tbody tr').forEach(row => {
            if (row.classList.contains('rf-hide')) return;

            const cells = row.querySelectorAll('td');
            const cellText = cells[timeColumnIndex] ? cells[timeColumnIndex].textContent.trim() : '';

            if (!cellText || !cellText.includes(':')) return;

            const duration = (durationColumnIndex !== -1 && cells[durationColumnIndex])
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
        });

        showBlockResult(timeFormatData, durationColumnIndex !== -1);
    }

    function showBlockError(message) {
        const section = getBlockSection();
        if (!section) return;

        section.className = 'rf-block-error';
        section.innerHTML = '';

        const title = document.createElement('div');
        title.style.fontWeight = 'bold';
        title.style.color = '#f44336';
        title.textContent = 'エラー';

        const msg = document.createElement('div');
        msg.style.marginTop = '5px';
        msg.textContent = message;

        section.appendChild(title);
        section.appendChild(msg);
    }

    function showBlockResult(timeFormatData, hasDurationColumn) {
        const section = getBlockSection();
        if (!section) return;

        section.className = '';
        section.innerHTML = '';

        const timeFormats = Object.entries(timeFormatData);
        timeFormats.sort((a, b) => (parseTimeToMinutes(a[0]) || 0) - (parseTimeToMinutes(b[0]) || 0));

        const totalTimeCount = Object.values(timeFormatData).reduce((s, d) => s + d.count, 0);

        const header = document.createElement('div');
        header.className = 'rf-block-header';

        const totalRow = document.createElement('div');
        totalRow.className = 'rf-block-row';

        const totalLabel = document.createElement('span');
        totalLabel.textContent = 'DP合計:';

        const totalValue = document.createElement('strong');
        totalValue.style.color = '#f57c00';
        totalValue.textContent = totalTimeCount + '名';

        totalRow.appendChild(totalLabel);
        totalRow.appendChild(totalValue);
        header.appendChild(totalRow);

        if (!hasDurationColumn) {
            const warn = document.createElement('div');
            warn.style.cssText = 'margin-top:5px;font-size:12px;color:#ff9800;';
            warn.textContent = 'シフトの長さ列が見つかりません';
            header.appendChild(warn);
        }

        section.appendChild(header);

        const titleEl = document.createElement('div');
        titleEl.className = 'rf-block-title';
        titleEl.textContent = 'Blockの内訳';
        section.appendChild(titleEl);

        if (timeFormats.length > 0) {
            timeFormats.forEach(([time, data]) => {
                const item = document.createElement('div');
                item.className = 'rf-block-item';

                const timeSpan = document.createElement('span');
                timeSpan.style.fontWeight = 'bold';
                timeSpan.textContent = time;

                const countSpan = document.createElement('span');
                countSpan.style.cssText = 'color:#f44336;font-weight:bold;';
                countSpan.textContent = data.count + '名';

                const durSpan = document.createElement('span');
                durSpan.style.color = '#666';
                durSpan.textContent = data.durations.join(', ') || '-';

                item.appendChild(timeSpan);
                item.appendChild(countSpan);
                item.appendChild(durSpan);
                section.appendChild(item);
            });
        } else {
            const empty = document.createElement('div');
            empty.style.color = '#999';
            empty.textContent = 'データがありません';
            section.appendChild(empty);
        }
    }

    /* ======================================================
       UI
    ====================================================== */

    function createPanel() {
        if (document.getElementById('rf-panel')) return;

        const savedKey = getSavedFilter();

        const panel = document.createElement('div');
        panel.id = 'rf-panel';

        const header = document.createElement('div');
        header.id = 'rf-header';

        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Filter';

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'rf-toggle';
        toggleBtn.textContent = '-';

        header.appendChild(headerTitle);
        header.appendChild(toggleBtn);
        panel.appendChild(header);

        const content = document.createElement('div');
        content.id = 'rf-content';

        const left = document.createElement('div');
        left.id = 'rf-left';

        FILTERS.forEach(f => {
            const lbl = document.createElement('label');
            const inp = document.createElement('input');
            inp.type = 'radio';
            inp.name = 'rf-filter';
            inp.value = f.key;
            if (f.key === savedKey) inp.checked = true;

            lbl.appendChild(inp);
            lbl.appendChild(document.createTextNode(f.label));
            left.appendChild(lbl);
        });

        const countDiv = document.createElement('div');
        countDiv.id = 'rf-count';
        countDiv.innerHTML = '<span class="rf-count-label">表示</span><span class="rf-count-val">-</span>';
        left.appendChild(countDiv);

        const dupDiv = document.createElement('div');
        dupDiv.id = 'rf-dup-count';
        dupDiv.style.display = 'none';
        left.appendChild(dupDiv);

        const btnGroup = document.createElement('div');
        btnGroup.id = 'rf-btn-group';

        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'rf-refresh';
        refreshBtn.className = 'rf-btn';
        refreshBtn.textContent = '更新';

        const copyBtn = document.createElement('button');
        copyBtn.id = 'rf-copy';
        copyBtn.className = 'rf-btn rf-btn-green';
        copyBtn.textContent = 'Copy';

        btnGroup.appendChild(refreshBtn);
        btnGroup.appendChild(copyBtn);
        left.appendChild(btnGroup);

        const legend = document.createElement('div');
        legend.id = 'rf-legend';
        // 凡例表示は不要のため空にしています
        left.appendChild(legend);

        const vdiv = document.createElement('div');
        vdiv.id = 'rf-vdivider';

        const right = document.createElement('div');
        right.id = 'rf-right';

        const blockSection = document.createElement('div');
        blockSection.id = 'rf-block-section';
        right.appendChild(blockSection);

        content.appendChild(left);
        content.appendChild(vdiv);
        content.appendChild(right);
        panel.appendChild(content);
        document.body.appendChild(panel);

        panel.addEventListener('change', e => {
            if (e.target.name === 'rf-filter') {
                const newKey = e.target.value;
                saveFilter(newKey);
                setNextCycleNames(newKey);
                doFilter();
                highlightRows();
                calculateBlocks();
            }
        });

        toggleBtn.onclick = function() {
            const isHidden = content.classList.toggle('hide');
            this.textContent = isHidden ? '+' : '-';
        };

        refreshBtn.onclick = function() {
            cacheAllCycleNames();
            const sel = document.querySelector('#rf-panel input:checked');
            const currentKey = sel ? sel.value : 'ALL';
            setNextCycleNames(currentKey);
            doFilter();
            highlightRows();
            calculateBlocks();
        };

        copyBtn.onclick = copyTableData;
    }

    /* ======================================================
       再描画監視
    ====================================================== */

    function setupObserver() {
        const table = getTable();
        if (!table || observer) return;

        observer = new MutationObserver(() => {
            if (isProcessing) return;
            setTimeout(() => {
                cacheAllCycleNames();
                const sel = document.querySelector('#rf-panel input:checked');
                const currentKey = sel ? sel.value : getSavedFilter();
                setNextCycleNames(currentKey);
                doFilter();
                highlightRows();
                calculateBlocks();
            }, 50);
        });

        observer.observe(table, {
            childList: true,
            subtree: true
        });
    }

    /* ======================================================
       初期化
    ====================================================== */

    function init() {
        createPanel();
        cacheAllCycleNames();

        const savedKey = getSavedFilter();
        setNextCycleNames(savedKey);

        doFilter();
        highlightRows();
        calculateBlocks();
        setupObserver();
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
