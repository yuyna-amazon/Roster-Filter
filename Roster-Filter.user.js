// ==UserScript==
// @name         Roster view
// @namespace    https://github.com/yuyna-amazon/Roster-Filter
// @version      5.5
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
        if (mins === null || mins === undefined || mins === Infinity) return '-';

        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ampm = h >= 12 ? 'pm' : 'am';

        h = h % 12;
        if (h === 0) h = 12;

        return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
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
    const cycleTimeCache  = {};
    let nextCycleNames = new Set();
    let nextCycleKey   = null;
    let isProcessing   = false;

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
        #rf-header span {
            font-weight: bold;
            font-size: 13px;
        }
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
        #rf-content.hide {
            display: none;
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
        }
        #rf-dup-count {
            margin-top: 4px;
            padding: 6px;
            background: #ffeeee;
            border-radius: 3px;
            color: #c00;
            font-size: 11px;
            line-height: 1.5;
        }

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
        .rf-btn:hover {
            background: #f0f0f0;
        }

        .rf-btn-green {
            border: none;
            background-color: #4CAF50;
            color: white;
        }
        .rf-btn-green:hover {
            background-color: #45a049;
        }

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

        .rf-hide {
            display: none !important;
        }

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

    function getFilterByKey(key) {
        return FILTERS.find(f => f.key === key) || null;
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
            const startTimeTd = row.querySelector('td[data-bind="text: startTime"]');
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
        if (cnt) cnt.textContent = '表示: ' + visible + ' / ' + total;
    }

    /* ======================================================
       サイクルの名前・時間キャッシュ管理
    ====================================================== */

    function cacheNamesAndTimesForFilter(filterKey) {
        if (filterKey === 'ALL') return;

        const rows = getRows();
        const names = new Set();

        let minStart = null;
        let maxEnd = null;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const startTimeTd = row.querySelector('td[data-bind="text: startTime"]');
            if (!startTimeTd) continue;

            const serviceTypeTd = row.querySelector('td[data-bind="text: serviceTypeName"]');
            if (serviceTypeTd && EXCLUDED_TYPES.includes(serviceTypeTd.textContent.trim())) continue;

            const startText = startTimeTd.textContent.trim();
            const cat = getCategory(parseTimeToMinutes(startText));
            if (cat !== filterKey) continue;

            const nameTd = row.querySelector('td[data-bind="text: DAName"]');
            if (nameTd) {
                const n = nameTd.textContent.trim();
                if (n) names.add(n);
            }

            const endTimeTd = row.querySelector('td[data-bind="text: endTime"]');
            const startMins = parseTimeToMinutes(startText);
            const endMins = parseTimeToMinutes(endTimeTd ? endTimeTd.textContent.trim() : '');

            if (startMins !== null && (minStart === null || startMins < minStart)) {
                minStart = startMins;
            }
            if (endMins !== null && (maxEnd === null || endMins > maxEnd)) {
                maxEnd = endMins;
            }
        }

        cycleNamesCache[filterKey] = names;
        cycleTimeCache[filterKey] = {
            start: minStart,
            end: maxEnd
        };
    }

    function cacheAllCycleNames() {
        FILTERS.forEach(f => {
            if (f.key !== 'ALL') cacheNamesAndTimesForFilter(f.key);
        });
    }

    function setNextCycleNames(currentKey) {
        const nKey = getNextCycleKey(currentKey);
        nextCycleKey = nKey;
        nextCycleNames = (nKey && cycleNamesCache[nKey]) ? cycleNamesCache[nKey] : new Set();
    }

    /* ======================================================
       Highlighter
    ====================================================== */

    function highlightRows() {
        if (isProcessing) return;
        isProcessing = true;

        const rows = Array.from(getRows());
        const now = new Date();

        const selectedFilter = document.querySelector('#rf-panel input:checked');
        const currentKey = selectedFilter ? selectedFilter.value : 'ALL';
        const checkDuplicates = currentKey !== 'ALL' && nextCycleNames.size > 0;

        let duplicateCount = 0;
        let index = 0;

        function processBatch() {
            const end = Math.min(index + BATCH_SIZE, rows.length);

            for (; index < end; index++) {
                const row = rows[index];
                const nameTd = row.querySelector('td[data-bind="text: DAName"]');

                if (row.classList.contains('rf-hide')) {
                    row.style.backgroundColor = '';
                    if (nameTd) {
                        nameTd.style.color = '';
                        nameTd.style.fontWeight = '';
                    }
                    continue;
                }

                const availabilityTd = row.querySelector('td[data-bind="text: availability"]');
                const endTimeTd = row.querySelector('td[data-bind="text: endTime"]');

                const availability = availabilityTd ? availabilityTd.textContent.trim() : '';
                const endTime = parseTimeToDate(endTimeTd ? endTimeTd.textContent.trim() : null);
                const name = nameTd ? nameTd.textContent.trim() : '';

                let newColor = '';
                let isActive = false;
                let isDuplicate = false;

                isDuplicate = checkDuplicates && !!name && nextCycleNames.has(name);
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

        const nextCycleTimes = cycleTimeCache[nextCycleKey] || {};
        const fallbackFilter = getFilterByKey(nextCycleKey);

        const startText = nextCycleTimes.start !== null && nextCycleTimes.start !== undefined
            ? minutesToDisplayTime(nextCycleTimes.start)
            : (fallbackFilter ? minutesToDisplayTime(fallbackFilter.min) : '-');

        const endText = nextCycleTimes.end !== null && nextCycleTimes.end !== undefined
            ? minutesToDisplayTime(nextCycleTimes.end)
            : (fallbackFilter && fallbackFilter.max !== Infinity ? minutesToDisplayTime(fallbackFilter.max) : '-');

        dupDiv.style.display = 'block';
        dupDiv.innerHTML =
            '<div><strong>' + nextCycleKey + '</strong></div>' +
            '<div>開始時間: ' + startText + '</div>' +
            '<div>終了時間: ' + endText + '</div>' +
            '<div>重複: <strong>' + count + '名</strong></div>';
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
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
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
        countDiv.textContent = '-';
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

        [
            { color: ACTIVE_COLOR,    label: '実行中' },
            { color: DUPLICATE_COLOR, label: '次Cycle重複' }
        ].forEach(({ color, label }) => {
            const item = document.createElement('div');
            item.className = 'rf-legend-item';

            const box = document.createElement('div');
            box.className = 'rf-legend-color';
            box.style.background = color;

            item.appendChild(box);
            item.appendChild(document.createTextNode(label));
            legend.appendChild(item);
        });

        const comboItem = document.createElement('div');
        comboItem.className = 'rf-legend-item';

        const comboBox = document.createElement('div');
        comboBox.className = 'rf-legend-color';
        comboBox.style.cssText = 'background:' + ACTIVE_COLOR + ';color:#c00;font-weight:bold;font-size:9px;text-align:center;line-height:14px;';
        comboBox.textContent = '名';

        comboItem.appendChild(comboBox);
        comboItem.appendChild(document.createTextNode('実行中＋重複'));
        legend.appendChild(comboItem);

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
