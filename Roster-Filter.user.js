// ==UserScript==
// @name         Roster view
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      7.3
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

    /* ======================================================
       定数
    ====================================================== */

    const STORAGE_KEY = 'rf-selected-filter';
    const BATCH_SIZE  = 50;

    const FILTERS = [
        { key: 'ALL',     label: '全て表示', min: -1,   max: -1 },
        { key: 'SSD_1',   label: 'SSD_1',    min: 0,    max: 390 },
        { key: 'SSD_1_B', label: 'SSD_1_B',  min: 390,  max: 570 },
        { key: 'SSD_2',   label: 'SSD_2',    min: 570,  max: 780 },
        { key: 'SSD_3',   label: 'SSD_3',    min: 780,  max: 990 },
        { key: 'SSD_3_B', label: 'SSD_3_B',  min: 990,  max: 1170 },
        { key: 'SSD_4',   label: 'SSD_4',    min: 1170, max: Infinity }
    ];

    const FILTER_INDEX = {};
    FILTERS.forEach((f, i) => {
        FILTER_INDEX[f.key] = i;
    });

    const EXCLUDED_TYPES  = ['AmFlex Kei Van (ProDP)'];
    const ACTIVE_COLOR    = '#ffffcc';
    const DUPLICATE_COLOR = '#ccf2ff';
    const MARKED_COLOR    = '#ffcccc';
    const MARKED_STORAGE_KEY = 'rf-marked-dpids';
    const MARKED_NAMES_KEY  = 'rf-marked-dpid-names';

    /* ======================================================
       状態管理
    ====================================================== */

    const cycleNamesCache = {};
    const cycleDetailCache = {};
    let nextCycleNames = new Set();
    let nextCycleKey   = null;
    let isProcessing   = false;
    let observer       = null;
    let observerTimer  = null;
    let suppressObserver = false;
    let markedDPIDs = [];
    let markedDPNames = {};
    let markFeatureEnabled = false;

    function loadMarkedDPIDs() {
        try {
            const stored = localStorage.getItem(MARKED_STORAGE_KEY);
            if (stored) {
                markedDPIDs = JSON.parse(stored);
            }
        } catch (e) {
            markedDPIDs = [];
        }
        try {
            const storedNames = localStorage.getItem(MARKED_NAMES_KEY);
            if (storedNames) {
                markedDPNames = JSON.parse(storedNames);
            }
        } catch (e) {
            markedDPNames = {};
        }
    }

    function saveMarkedDPIDs() {
        localStorage.setItem(MARKED_STORAGE_KEY, JSON.stringify(markedDPIDs));
    }

    function saveMarkedDPNames() {
        localStorage.setItem(MARKED_NAMES_KEY, JSON.stringify(markedDPNames));
    }

    function isMarkedDPID(id) {
        if (!markFeatureEnabled) return false;
        const lower = id.toLowerCase();
        return markedDPIDs.some(marked => marked.toLowerCase() === lower);
    }

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
        #rf-content.rf-collapsed #rf-count,
        #rf-content.rf-collapsed #rf-dup-count,
        #rf-content.rf-collapsed #rf-btn-group,
        #rf-content.rf-collapsed #rf-legend,
        #rf-content.rf-collapsed #rf-vdivider,
        #rf-content.rf-collapsed #rf-right,
        #rf-content.rf-collapsed #rf-mark-vdivider,
        #rf-content.rf-collapsed #rf-mark-panel {
            display: none !important;
        }

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
            background: #e0f4ff;
            border-radius: 3px;
            color: #0066cc;
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

        #rf-mark-panel {
            min-width: 160px;
            flex-shrink: 0;
            padding-left: 10px;
        }
        #rf-mark-vdivider {
            width: 1px;
            background: #ddd;
            align-self: stretch;
            flex-shrink: 0;
        }
        #rf-mark-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid #c00;
        }
        #rf-mark-panel-header span { font-weight: bold; font-size: 11px; color: #c00; }
        #rf-mark-input-row {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
        }
        #rf-mark-input {
            flex: 1;
            padding: 4px 6px;
            border: 1px solid #ccc;
            border-radius: 3px;
            font-size: 11px;
            min-width: 0;
        }
        #rf-mark-add-btn {
            padding: 4px 8px;
            background: #c00;
            color: #fff;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            white-space: nowrap;
        }
        #rf-mark-add-btn:hover { background: #a00; }
        #rf-mark-list {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 200px;
            overflow-y: auto;
        }
        #rf-mark-list li {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 6px;
            margin: 2px 0;
            background: #e8e8e8;
            border-radius: 3px;
            border: 1px solid #ccc;
        }
        #rf-mark-list li span {
            font-size: 11px;
            color: #c00;
            font-weight: bold;
        }
        .rf-mark-del-btn {
            background: none;
            border: none;
            color: #c00;
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
            line-height: 1;
            font-weight: bold;
        }
        .rf-mark-del-btn:hover { color: #900; }
        #rf-mark-empty {
            color: #999;
            text-align: center;
            padding: 8px;
            font-style: italic;
            font-size: 11px;
        }
        #rf-mark-clear-btn {
            margin-top: 6px;
            padding: 4px 8px;
            background: #fff;
            color: #c00;
            border: 1px solid #c00;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            width: 100%;
        }
        #rf-mark-clear-btn:hover { background: #fff0f0; }

        td.rf-has-next {
            position: relative;
            padding-right: 48px !important;
            box-sizing: border-box;
            line-height: 20px !important;
            vertical-align: middle !important;
        }

        .rf-has-next::after {
            content: attr(data-rf-next-time) " " attr(data-rf-next-period);
            position: absolute;
            right: 2px;
            top: calc(50% - 1px);
            transform: translateY(-50%);
            font-size: 13px;
            line-height: 13px;
            letter-spacing: 0;
            color: #0066cc;
            font-weight: bold;
            white-space: nowrap;
            pointer-events: none;
            z-index: 5;
            text-align: center;
            overflow: visible;
            background: transparent;
            margin: 0;
            padding: 0;
        }
    `;
    document.head.appendChild(style);

    /* ======================================================
       共通実行ラッパー
    ====================================================== */

    function runInternalUpdate(fn) {
        suppressObserver = true;
        try {
            fn();
        } finally {
            setTimeout(() => {
                suppressObserver = false;
            }, 0);
        }
    }

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

    function getTransporterIdCell(row) {
        let td = row.querySelector('td[data-bind="text: transporterId"]');
        if (td) return td;

        const candidates = row.querySelectorAll('td[data-bind]');
        for (const candidate of candidates) {
            const bind = (candidate.getAttribute('data-bind') || '').toLowerCase();
            if (bind.includes('text:') && bind.includes('transporterid')) {
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
        if (cnt) {
            cnt.innerHTML =
                '<span class="rf-count-label">表示</span>' +
                '<span class="rf-count-val">' + visible + ' / ' + total + '</span>';
        }
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

            const startText = startTimeTd.textContent.trim();
            const cat = getCategory(parseTimeToMinutes(startText));
            if (cat !== filterKey) continue;

            const nameTd = getNameCell(row);
            const endTimeTd = getEndTimeCell(row);

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

    function rememberOriginalCellState(td) {
        if (!td) return;
        if (td.dataset.rfOriginalPosition === undefined) {
            td.dataset.rfOriginalPosition = td.style.position || '';
        }
        if (td.dataset.rfOriginalPaddingRight === undefined) {
            td.dataset.rfOriginalPaddingRight = td.style.paddingRight || '';
        }
        if (td.dataset.rfOriginalLineHeight === undefined) {
            td.dataset.rfOriginalLineHeight = td.style.lineHeight || '';
        }
        if (td.dataset.rfOriginalVerticalAlign === undefined) {
            td.dataset.rfOriginalVerticalAlign = td.style.verticalAlign || '';
        }
    }

    function restoreCellHtml(td) {
        if (!td) return;

        if (td.dataset.rfOriginalPosition !== undefined) {
            td.style.position = td.dataset.rfOriginalPosition || '';
            delete td.dataset.rfOriginalPosition;
        }
        if (td.dataset.rfOriginalPaddingRight !== undefined) {
            td.style.paddingRight = td.dataset.rfOriginalPaddingRight || '';
            delete td.dataset.rfOriginalPaddingRight;
        }
        if (td.dataset.rfOriginalLineHeight !== undefined) {
            td.style.lineHeight = td.dataset.rfOriginalLineHeight || '';
            delete td.dataset.rfOriginalLineHeight;
        }
        if (td.dataset.rfOriginalVerticalAlign !== undefined) {
            td.style.verticalAlign = td.dataset.rfOriginalVerticalAlign || '';
            delete td.dataset.rfOriginalVerticalAlign;
        }

        if (td.classList.contains('rf-has-next')) {
            td.classList.remove('rf-has-next');
        }

        delete td.dataset.rfNextTime;
        delete td.dataset.rfNextPeriod;
    }

    function clearNextCycleInfoFromBody() {
        const table = getTable();
        if (!table) return;

        table.querySelectorAll('td.rf-has-next').forEach(td => {
            restoreCellHtml(td);
        });
    }

    function injectNextCycleInfoIntoBody(endTd, nextInfo) {
        if (!endTd || !nextInfo) return;

        rememberOriginalCellState(endTd);

        try {
            endTd.style.position = 'relative';
        } catch (e) {}

        const nextStart = (nextInfo.start !== null && nextInfo.start !== undefined)
            ? minutesToDisplayTime(nextInfo.start)
            : '-';

        const parts = String(nextStart).split(/\s+/);
        const timePart = parts[0] || nextStart;
        const periodPart = parts[1] || '';

        endTd.dataset.rfNextTime = timePart || '';
        endTd.dataset.rfNextPeriod = periodPart || '';
        endTd.classList.add('rf-has-next');
    }

    /* ======================================================
       Highlighter
    ====================================================== */

    function highlightRows() {
        if (isProcessing) return;
        isProcessing = true;

        runInternalUpdate(() => {
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
                        if (endTd) restoreCellHtml(endTd);
                        continue;
                    }

                    const availabilityTd = row.querySelector('td[data-bind="text: availability"]');
                    const availability = availabilityTd ? availabilityTd.textContent.trim() : '';

                    const startTime = parseTimeToDate(startTd ? startTd.textContent.trim() : null);
                    let endTime = parseTimeToDate(endTd ? endTd.textContent.trim() : null);

                    if (startTime && endTime && endTime < startTime) {
                        endTime.setDate(endTime.getDate() + 1);
                    }

                    const name = nameTd ? nameTd.textContent.trim() : '';
                    const normalizedName = normalizeName(name);

                    const transporterIdTd = getTransporterIdCell(row);
                    const transporterId = transporterIdTd ? transporterIdTd.textContent.trim() : '';

                    let newColor = '';
                    let isActive = false;
                    let isDuplicate = false;
                    let isMarked = false;

                    const nextInfo = normalizedName ? nextDetailMap.get(normalizedName) : null;

                    isDuplicate = checkDuplicates && !!normalizedName && nextCycleNames.has(normalizedName);
                    isActive = (!endTime || endTime >= now) && (availability === '実行中');
                    isMarked = !!transporterId && isMarkedDPID(transporterId);

                    if (isDuplicate) duplicateCount++;

                    if (isActive) {
                        newColor = ACTIVE_COLOR;
                    } else if (isMarked) {
                        newColor = MARKED_COLOR;
                    } else if (isDuplicate) {
                        newColor = DUPLICATE_COLOR;
                    }

                    row.style.backgroundColor = newColor;

                    if (nameTd) {
                        if (isActive && isDuplicate) {
                            nameTd.style.color = '#0066cc';
                            nameTd.style.fontWeight = 'bold';
                        } else {
                            nameTd.style.color = '';
                            nameTd.style.fontWeight = '';
                        }
                    }

                    if (transporterIdTd) {
                        if (isMarked) {
                            transporterIdTd.style.color = '#c00';
                            transporterIdTd.style.fontWeight = 'bold';
                        } else {
                            transporterIdTd.style.color = '';
                            transporterIdTd.style.fontWeight = '';
                        }
                    }

                    if (isDuplicate && nextInfo && endTd) {
                        injectNextCycleInfoIntoBody(endTd, nextInfo);
                    } else if (endTd) {
                        restoreCellHtml(endTd);
                    }
                }

                if (index < rows.length) {
                    setTimeout(processBatch, 0);
                } else {
                    updateDuplicateCount(duplicateCount, currentKey);
                    isProcessing = false;
                    if (markFeatureEnabled) renderMarkList();
                }
            }

            processBatch();
        });
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
        dupDiv.innerHTML =
            '<span class="rf-dup-key"><strong>' + nextCycleKey + '</strong></span>' +
            '<span class="rf-dup-val">重複: <strong>' + count + '名</strong></span>';
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

        const attrNote = td.dataset && td.dataset.rfNextTime
            ? ((td.dataset.rfNextTime || '') + (td.dataset.rfNextPeriod ? ' ' + td.dataset.rfNextPeriod : ''))
            : null;

        if (!attrNote) return td.textContent.trim();

        const full = td.textContent || '';
        return full.replace(attrNote, '').trim();
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

        const markToggleBtn = document.createElement('button');
        markToggleBtn.id = 'rf-mark-toggle';
        markToggleBtn.className = 'rf-btn';
        markToggleBtn.style.background = '#999';
        markToggleBtn.style.color = '#fff';
        markToggleBtn.style.borderColor = '#999';
        markToggleBtn.textContent = 'DP ID: OFF';

        const copyBtn = document.createElement('button');
        copyBtn.id = 'rf-copy';
        copyBtn.className = 'rf-btn rf-btn-green';
        copyBtn.textContent = 'Copy';

        btnGroup.appendChild(markToggleBtn);
        btnGroup.appendChild(copyBtn);
        left.appendChild(btnGroup);

        const legend = document.createElement('div');
        legend.id = 'rf-legend';
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

                runInternalUpdate(() => {
                    setNextCycleNames(newKey);
                    doFilter();
                    highlightRows();
                    calculateBlocks();
                });
            }
        });

        toggleBtn.onclick = function() {
            const isHidden = !content.classList.contains('rf-collapsed');
            content.classList.toggle('rf-collapsed', isHidden);
            this.textContent = isHidden ? '+' : '-';
        };

        markToggleBtn.onclick = function() {
            markFeatureEnabled = !markFeatureEnabled;
            this.textContent = markFeatureEnabled ? 'DP ID: ON' : 'DP ID: OFF';
            this.style.background = markFeatureEnabled ? '#c00' : '#999';
            this.style.borderColor = markFeatureEnabled ? '#c00' : '#999';

            const markPanel = document.getElementById('rf-mark-panel');
            const markDiv = document.getElementById('rf-mark-vdivider');
            if (markPanel) markPanel.style.display = markFeatureEnabled ? '' : 'none';
            if (markDiv) markDiv.style.display = markFeatureEnabled ? '' : 'none';

            runInternalUpdate(() => { highlightRows(); });
        };

        copyBtn.onclick = copyTableData;
    }

    /* ======================================================
       DP ID登録パネル
    ====================================================== */

    function createMarkPanel() {
        const content = document.getElementById('rf-content');
        if (!content) return;

        const markDivider = document.createElement('div');
        markDivider.id = 'rf-mark-vdivider';

        const panel = document.createElement('div');
        panel.id = 'rf-mark-panel';

        panel.innerHTML =
            '<div id="rf-mark-panel-header">' +
                '<span>DP ID登録</span>' +
            '</div>' +
            '<div id="rf-mark-input-row">' +
                '<input id="rf-mark-input" type="text" placeholder="DP IDを入力">' +
                '<button id="rf-mark-add-btn">追加</button>' +
            '</div>' +
            '<ul id="rf-mark-list"></ul>' +
            '<button id="rf-mark-clear-btn">全て削除</button>';

        content.appendChild(markDivider);
        content.appendChild(panel);

        if (!markFeatureEnabled) {
            panel.style.display = 'none';
            markDivider.style.display = 'none';
        }

        document.getElementById('rf-mark-add-btn').onclick = function() {
            const input = document.getElementById('rf-mark-input');
            const val = input.value.trim();
            if (!val) return;

            const ids = val.split(/[\n,\s]+/).filter(s => s.trim());
            ids.forEach(id => {
                const trimmed = id.trim();
                if (trimmed && !markedDPIDs.some(existing => existing === trimmed)) {
                    markedDPIDs.push(trimmed);
                }
            });
            saveMarkedDPIDs();
            input.value = '';
            renderMarkList();
            runInternalUpdate(() => { highlightRows(); });
        };

        document.getElementById('rf-mark-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('rf-mark-add-btn').click();
            }
        });

        document.getElementById('rf-mark-clear-btn').onclick = function() {
            if (markedDPIDs.length === 0) return;
            markedDPIDs = [];
            markedDPNames = {};
            saveMarkedDPIDs();
            saveMarkedDPNames();
            renderMarkList();
            runInternalUpdate(() => { highlightRows(); });
        };
    }

    function findDPNameById(dpId) {
        const rows = getRows();
        const lowerDpId = dpId.toLowerCase();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const tidTd = getTransporterIdCell(row);
            if (tidTd && tidTd.textContent.trim().toLowerCase() === lowerDpId) {
                const nameTd = getNameCell(row);
                const name = nameTd ? nameTd.textContent.trim() : '';
                if (name) {
                    markedDPNames[lowerDpId] = name;
                    saveMarkedDPNames();
                }
                return name;
            }
        }
        // ページ上に見つからない場合はキャッシュから返す
        return markedDPNames[lowerDpId] || '';
    }

    function refreshUnknownDPNames() {
        let updated = false;
        markedDPIDs.forEach(id => {
            const lowerDpId = id.toLowerCase();
            if (!markedDPNames[lowerDpId]) {
                const name = findDPNameById(id);
                if (name) {
                    updated = true;
                }
            }
        });
        if (updated) {
            renderMarkList();
        }
    }

    function countDPIdHits(dpId) {
        const rows = getRows();
        const lowerDpId = dpId.toLowerCase();
        let count = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const tidTd = getTransporterIdCell(row);
            if (tidTd && tidTd.textContent.trim().toLowerCase() === lowerDpId) {
                count++;
            }
        }
        return count;
    }

    function renderMarkList() {
        const list = document.getElementById('rf-mark-list');
        if (!list) return;

        if (markedDPIDs.length === 0) {
            list.innerHTML = '<div id="rf-mark-empty">登録なし</div>';
            return;
        }

        list.innerHTML = '';
        markedDPIDs.forEach((id, idx) => {
            const li = document.createElement('li');

            const infoDiv = document.createElement('div');
            infoDiv.style.display = 'flex';
            infoDiv.style.flexDirection = 'column';
            infoDiv.style.gap = '2px';

            const idSpan = document.createElement('span');
            idSpan.textContent = id;
            idSpan.style.fontSize = '12px';
            idSpan.style.color = '#c00';
            idSpan.style.fontWeight = 'bold';

            const nameRow = document.createElement('div');
            nameRow.style.display = 'flex';
            nameRow.style.alignItems = 'center';
            nameRow.style.gap = '6px';

            const nameSpan = document.createElement('span');
            const dpName = findDPNameById(id);
            nameSpan.textContent = dpName || '（不明）';
            nameSpan.style.fontSize = '11px';
            nameSpan.style.color = '#555';

            nameRow.appendChild(nameSpan);

            const hits = countDPIdHits(id);
            if (hits > 0) {
                const hitSpan = document.createElement('span');
                hitSpan.textContent = hits + '件';
                hitSpan.style.fontSize = '10px';
                hitSpan.style.color = '#fff';
                hitSpan.style.background = '#c00';
                hitSpan.style.borderRadius = '3px';
                hitSpan.style.padding = '1px 4px';
                nameRow.appendChild(hitSpan);
            }

            infoDiv.appendChild(idSpan);
            infoDiv.appendChild(nameRow);

            const delBtn = document.createElement('button');
            delBtn.className = 'rf-mark-del-btn';
            delBtn.textContent = '×';
            delBtn.onclick = function() {
                const removedId = markedDPIDs[idx].toLowerCase();
                markedDPIDs.splice(idx, 1);
                delete markedDPNames[removedId];
                saveMarkedDPIDs();
                saveMarkedDPNames();
                renderMarkList();
                runInternalUpdate(() => { highlightRows(); });
            };

            li.appendChild(infoDiv);
            li.appendChild(delBtn);
            list.appendChild(li);
        });
    }

    function renderMarkListOnInit() {
        renderMarkList();
    }

    /* ======================================================
       再描画監視
    ====================================================== */

    function setupObserver() {
        const table = getTable();
        if (!table || observer) return;

        observer = new MutationObserver((mutations) => {
            if (isProcessing || suppressObserver) return;

            let shouldReact = false;

            for (const m of mutations) {
                if (m.target && m.target.closest && m.target.closest('#rf-panel')) {
                    continue;
                }

                const targetEl = m.target && m.target.nodeType === 1 ? m.target : null;

                if (targetEl) {
                    if (targetEl.classList.contains('rf-has-next')) continue;
                    if (targetEl.closest && targetEl.closest('#rf-panel')) continue;
                }

                shouldReact = true;
                break;
            }

            if (!shouldReact) return;

            clearTimeout(observerTimer);
            observerTimer = setTimeout(() => {
                if (suppressObserver) return;

                runInternalUpdate(() => {
                    cacheAllCycleNames();
                    const sel = document.querySelector('#rf-panel input:checked');
                    const currentKey = sel ? sel.value : getSavedFilter();
                    setNextCycleNames(currentKey);
                    doFilter();
                    highlightRows();
                    calculateBlocks();
                });
            }, 80);
        });

        observer.observe(table, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
    }

    /* ======================================================
       初期化
    ====================================================== */

    function init() {
        loadMarkedDPIDs();
        createPanel();
        createMarkPanel();
        renderMarkListOnInit();

        runInternalUpdate(() => {
            cacheAllCycleNames();

            const savedKey = getSavedFilter();
            setNextCycleNames(savedKey);

            doFilter();
            highlightRows();
            calculateBlocks();
            setupObserver();

            refreshUnknownDPNames();
        });
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
