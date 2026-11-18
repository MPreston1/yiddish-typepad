'use strict';

// ── Unicode normalization ───────────────────────────────────────────────────
// normalizeYiddishWithMap() is the single source of truth for every rule
// below. It walks the original text once, left to right, and for each
// "chunk" it consumes (1 original char that expands to 2, or 2 original
// chars that collapse to 1, or an ordinary passthrough char) it records
// both the normalized-text range and the original-text range that chunk
// came from. This lets callers that only need the normalized string ignore
// the map (see normalizeYiddish() below), while callers that need to
// highlight matches in the *original* text (see highlightTokens()) can
// convert a match found in normalized coordinates back to original
// coordinates.
//
// Rule behavior is identical to the previous chained-.replace() version,
// with one correction: U+FB1F is now fully decomposed all the way down to
// its primitive letters, matching what U+05F2 already produces on its own.
//   U+05F2 (Yod-Yod ligature, "double yod")            -> U+05D9 + U+05D9
//   U+FB1F (Yod-Yod-Patah ligature)                    -> U+05D9 + U+05D9 + U+05B7
//   U+05F0 (Vov-Vov ligature, "double vov")             -> U+05D5 + U+05D5
//   U+05F1 (Vov-Yod ligature)                           -> U+05D5 + U+05D9
//   U+05D1 + U+05BF (Vet, "bet" + rafe)                 -> U+05D1
//   U+05E4 + U+05BF (Fey, "pey" + rafe)                 -> U+05E4
//   U+05D5 + U+05BC (Vov + dagesh, "vov melupm")        -> U+05D5
//   U+05EA + U+05BC (Tav + dagesh)                       -> U+05EA
//   U+05DB + U+05BC (Kof, "khof" + dagesh)               -> U+05DB
//   U+05D9 + U+05B4 (Yod + hiriq, "yud khirik")          -> U+05D9
//   U+FB1D (Yod-with-hiriq precomposed ligature)          -> U+05D9
// FB1F is fully expanded (rather than left as U+05F2 + U+05B7) because text
// sourced from different places encodes "pasekh tsvey yudn" inconsistently:
// some as the single precomposed U+FB1F character, some as a separate
// U+05F2 ligature followed by a combining patah, and some as fully spelled-
// out keyboard input (two plain yuds + patah). Since the loop only checks
// each rule against characters in the *original* text (it never re-scans
// its own output), leaving FB1F at the intermediate U+05F2 + U+05B7 stage
// meant it could never reach the same fully-decomposed form the other two
// encodings produce -- so a word stored with a precomposed FB1F would never
// match the same word typed on a keyboard. Fully decomposing all three
// representations down to the same primitive letters fixes that. Pey +
// dagesh (U+05BC, "פּ") is intentionally left untouched, because YCD
// included the dagesh. Kof + dagesh (U+05BC, "כּ"), by contrast, is
// folded down to plain kof (כ) because YCD does not include the dagesh.
// Yod + hiriq (U+05B4, "יִ") is likewise folded down to plain yod (י), so
// that a search containing the pointed form also catches entries spelled
// with a bare yod (and vice versa, since the query and the entry text are
// both normalized). As with FB1F above, this letter can be encoded two
// ways depending on the source: as the single precomposed character U+FB1D,
// or as a plain yod followed by a separate combining hiriq (what a keyboard
// typically produces). Both are handled so they reduce to the same plain yod.
function normalizeYiddishWithMap(text) {
    let normalized = '';
    const chunks = []; // { normStart, normEnd, origStart, origEnd }
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const c2 = i + 1 < text.length ? text[i + 1] : '';
        let out, consumed;
        if (c === '\u05F2') {
            out = '\u05D9\u05D9';
            consumed = 1;
        } else if (c === '\uFB1F') {
            out = '\u05D9\u05D9\u05B7';
            consumed = 1;
        } else if (c === '\u05F0') {
            out = '\u05D5\u05D5';
            consumed = 1;
        } else if (c === '\u05F1') {
            out = '\u05D5\u05D9';
            consumed = 1;
        } else if (c === '\u05D1' && c2 === '\u05BF') {
            out = '\u05D1';
            consumed = 2;
        } else if (c === '\u05E4' && c2 === '\u05BF') {
            out = '\u05E4';
            consumed = 2;
        } else if (c === '\u05D5' && c2 === '\u05BC') {
            out = '\u05D5';
            consumed = 2;
        } else if (c === '\u05EA' && c2 === '\u05BC') {
            out = '\u05EA';
            consumed = 2;
        } else if (c === '\uFB1D') {
            out = '\u05D9';
            consumed = 1;
        } else if (c === '\u05D9' && c2 === '\u05B4') {
            out = '\u05D9';
            consumed = 2;
        } else if (c === '\u05DB' && c2 === '\u05BC') {
            out = '\u05DB';
            consumed = 2;
        } else {
            out = c;
            consumed = 1;
        }

        const normStart = normalized.length;
        normalized += out;
        chunks.push({normStart, normEnd: normalized.length, origStart: i, origEnd: i + consumed});
        i += consumed;
    }
    return {normalized, chunks};
}

function normalizeYiddish(text) {
    return normalizeYiddishWithMap(text).normalized;
}

// Finds the chunk containing a given index into the normalized string
// (0 <= idx < chunks-covered length). Used to map a match found in
// normalized coordinates back to the original text's coordinates.
function findChunkForNormIndex(chunks, idx) {
    let lo = 0, hi = chunks.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ch = chunks[mid];
        if (idx < ch.normStart) hi = mid - 1;
        else if (idx >= ch.normEnd) lo = mid + 1;
        else return ch;
    }
    return null;
}

// ── State ────────────────────────────────────────────────────────────────────
let appData = {source_name: null, download_date: '', entries: []};
let currentMatches = [];   // entries from last search
let findMatches = [];    // DOM text nodes + offsets for find-in-page
let findIndex = -1;

// ── Persistence via IndexedDB ─────────────────────────────────────────────────
// IndexedDB is far more persistent than localStorage on iOS PWAs --
// Safari does not evict it the way it does localStorage.
const IDB_NAME = 'DictionaryApp';
const IDB_STORE = 'data';
const IDB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function saveData() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        // Store metadata and entries separately so we can load metadata fast
        st.put({
            source_name: appData.source_name,
            download_date: appData.download_date
        }, 'meta');
        st.put(appData.entries, 'entries');
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        // Fall back to localStorage if IndexedDB fails
        try {
            localStorage.setItem('dict_backup', JSON.stringify(appData));
        } catch (_) {
        }
        console.warn('IndexedDB save failed:', e);
    }
}

async function loadData() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const st = tx.objectStore(IDB_STORE);
        const meta = await new Promise((res, rej) => {
            const r = st.get('meta');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        const entries = await new Promise((res, rej) => {
            const r = st.get('entries');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        db.close();
        if (meta && entries) {
            appData = {...meta, entries};
            return true;
        }
    } catch (e) {
        console.warn('IndexedDB load failed:', e);
    }
    // Try localStorage fallback
    try {
        const raw = localStorage.getItem('dict_backup');
        if (raw) {
            appData = JSON.parse(raw);
            return true;
        }
    } catch (_) {
    }
    return false;
}

// ── JNW local backup storage (separate keys, same IndexedDB store) ─────────
async function saveJNWBackupToDB(meta, entries) {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        st.put(meta, 'jnw_backup_meta');
        st.put(entries, 'jnw_backup_entries');
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        console.warn('JNW backup save failed:', e);
    }
}

async function loadJNWBackupFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const st = tx.objectStore(IDB_STORE);
        const meta = await new Promise((res, rej) => {
            const r = st.get('jnw_backup_meta');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        const entries = await new Promise((res, rej) => {
            const r = st.get('jnw_backup_entries');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        db.close();
        if (meta && entries) return {meta, entries};
    } catch (e) {
        console.warn('JNW backup load failed:', e);
    }
    return null;
}

async function clearJNWBackupFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        st.delete('jnw_backup_meta');
        st.delete('jnw_backup_entries');
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        console.warn('JNW backup clear failed:', e);
    }
}

// ── HTML parsing (mirrors Python logic) ──────────────────────────────────────
const STOP_TERM = 'Notes, Abbreviations & Symbols';

function parseHTML(html) {
    // Pre-processing: remove malformed tags that cause false entry splits
    html = html.replace(/<p[^>]*><\/main><\/p>\s*/gi, '');
    html = html.replace(/<p[^>]*><main[^>]*><\/p>\s*/gi, '');
    // Remove <p> tags containing only an <img> -- they become false sentinels
    html = html.replace(/<p[^>]*>\s*(?:<a[^>]*>)?\s*<img[^>]*\/?>[^<]*(?:<\/a>)?\s*<\/p>\s*/gi, '');

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const firstMain = doc.querySelector('main');
    if (!firstMain) return [];

    const allParas = Array.from(doc.querySelectorAll('p'));
    const paras = [];
    for (const p of allParas) {
        const pos = firstMain.compareDocumentPosition(p);
        if (!(pos & 4) && !(pos & 16)) continue;
        let text = p.textContent;
        const stripped = text.replace(/\u00a0/g, '').replace(/&nbsp;/g, '').trim();
        if (stripped === '') {
            paras.push('');
        } else {
            text = text.replace(/\u00a0/g, ' ').replace(/&nbsp;/g, ' ').trim();
            paras.push(text);
        }
    }

    // Helper functions
    function startsWithLatin(text) {
        for (const c of text) {
            const cp = c.codePointAt(0);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return true;
            if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return false;
        }
        return false;
    }

    function splitMixedPara(text) {
        // Split a paragraph that starts with a Latin term followed by Hebrew.
        // Does NOT split paragraphs that start with Hebrew (definitions with
        // transliteration in brackets should not be mistaken for terms).
        if (!startsWithLatin(text)) return null;
        let inLatin = false;
        for (let i = 0; i < text.length; i++) {
            const cp = text.codePointAt(i);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) inLatin = true;
            if (inLatin && ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f))) {
                let splitPos = i;
                while (splitPos > 0 && (text[splitPos - 1] === ' ' || text[splitPos - 1] === '\u00a0')) splitPos--;
                const termPart = text.slice(0, splitPos).trim();
                const defPart = text.slice(splitPos).trim();
                if (termPart && defPart) return [termPart, defPart];
            }
        }
        return null;
    }

    function cleanTerm(text) {
        // Strip leading non-Latin characters (e.g. stray Hebrew prefix chars like ך)
        for (let i = 0; i < text.length; i++) {
            const cp = text.codePointAt(i);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return text.slice(i).trim();
        }
        return text.trim();
    }

    const entries = [];

    // Some source paragraphs contain an unbalanced term due to authoring
    // mistakes in the original HTML (see cleanTerm's note above about
    // stray leading characters) -- most commonly a missing closing
    // parenthesis, e.g. "advanced (academic level" with no ")". Rather
    // than silently leaving the term malformed, auto-append the missing
    // closing parenthes(es) and record a note on the entry so this is
    // visible (e.g. in the exported backup JSON) rather than silently
    // "fixed" and forgotten.
    function pushEntry(rawTerm, definition) {
        const term = cleanTerm(rawTerm);
        const opens = (term.match(/\(/g) || []).length;
        const closes = (term.match(/\)/g) || []).length;
        const missing = opens - closes;
        if (missing > 0) {
            entries.push({
                term: term + ')'.repeat(missing),
                definition,
                note: `Auto-added ${missing} closing parenthes${missing === 1 ? 'is' : 'es'} ` +
                    `(source term was unbalanced: "${term}")`
            });
        } else {
            entries.push({term, definition});
        }
    }

    let current = [];
    let i = 0;

    while (i < paras.length) {
        const para = paras[i];

        if (para === '') {
            if (current.length > 0) {
                // Lookahead: find next non-blank paragraph
                let j = i + 1;
                while (j < paras.length && paras[j] === '') j++;
                const nextPara = j < paras.length ? paras[j] : '';

                if (nextPara.trim() === STOP_TERM) {
                    if (current[0].trim() !== STOP_TERM)
                        pushEntry(current[0], current.slice(1));
                    break;
                }

                if (startsWithLatin(nextPara) || !nextPara) {
                    // Next para starts with Latin -> genuine end of entry
                    if (current[0].trim() !== STOP_TERM)
                        pushEntry(current[0], current.slice(1));
                    current = [];
                }
                // else: next para starts with Hebrew -> internal blank, keep going
            }
            i++;
            continue;
        }

        if (current.length === 0) {
            if (para.trim() === STOP_TERM) break;

            // Handle newline-separated term+definition (from <br/> in HTML)
            if (para.includes('\n')) {
                const parts = para.split('\n').map(p => p.trim()).filter(Boolean);
                if (parts.length > 1 && startsWithLatin(parts[0])) {
                    current.push(cleanTerm(parts[0]));
                    for (let k = 1; k < parts.length; k++) current.push(parts[k]);
                    i++;
                    continue;
                }
            }

            // Handle &nbsp;-separated term+definition in the same paragraph
            const split = splitMixedPara(para);
            if (split) {
                current.push(cleanTerm(split[0]));
                current.push(split[1]);
                i++;
                continue;
            }

            current.push(para);
        } else {
            current.push(para);
        }
        i++;
    }

    if (current.length > 0 && current[0].trim() !== STOP_TERM)
        pushEntry(current[0], current.slice(1));

    return entries;
}

// ── Bidi term display (mirrors Python logic) ──────────────────────────────────
const MIRROR = {'(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<'};

function mirrorChar(c) {
    return MIRROR[c] || c;
}

function bidiTermDisplay(text) {
    if (!text) return text;
    // Find first strong LTR character
    let first = -1;
    for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i);
        // Latin, Greek, Cyrillic, digits etc — not Hebrew (0x0590–0x05FF)
        if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
            (cp >= 0x30 && cp <= 0x39) || (cp >= 0xC0 && cp <= 0x2AF) ||
            (cp >= 0x370 && cp <= 0x52F)) {
            first = i;
            break;
        }
    }
    if (first <= 0) return text;
    const leading = text.slice(0, first);
    const rest = text.slice(first);
    return rest + [...leading].reverse().map(mirrorChar).join('');
}

// ── Search ────────────────────────────────────────────────────────────────────
function doSearch() {
    const query = document.getElementById('search-input').value.trim();

    const wholeWord = document.getElementById('whole-word').checked;
    const exactPhrase = document.getElementById('exact-phrase').checked;
    const jnwDisplayAll = document.getElementById('jnw-display-all').checked;
    const enabled = enabledDicts();

    // Kick off the JNW live search in parallel; it has its own loading/empty
    // states. JNW's own API has no scope/whole-word/exact-phrase options, so
    // "whole word" and "exact phrase" are applied by filtering JNW's results
    // client-side (see filterJNWEntriesByTerm); "term or definition" scope
    // doesn't apply to JNW at all, since it always searches across its own
    // fields.
    if (enabled.includes('jnw')) {
        searchJNW(query, {wholeWord, exactPhrase, displayAll: jnwDisplayAll});
    }
    if (enabled.includes('ceyd')) searchCeyd(query);

    if (!enabled.includes('ycd')) {
        // YCD column is hidden; nothing more to do on that side.
        closeFind(true);
        return;
    }

    const entries = appData.entries;
    const results = document.getElementById('results-ycd');
    const countEl = document.getElementById('count-ycd');

    if (!entries.length) {
        results.innerHTML = '<p class="message">No dictionary loaded.</p>';
        countEl.textContent = '';
        return;
    }
    if (!query) {
        results.innerHTML = '<p class="message">Type a word and tap Search.</p>';
        countEl.textContent = `${entries.length.toLocaleString()} entries loaded`;
        return;
    }

    // Normalize so U+FB1F matches keyboard-typed U+05F2+U+05B7
    const qNorm = normalizeYiddish(query.toLowerCase());
    const tokens = qNorm.split(/\s+/).filter(Boolean);


    function entryMatches(term, defnText) {
        const t = normalizeYiddish(term.toLowerCase());
        const d = normalizeYiddish(defnText.toLowerCase());
        if (exactPhrase && wholeWord) {
            // Both conditions together: the whole phrase, adjacent/in-order,
            // AND bounded by word boundaries at its start and end (so it can't
            // be embedded inside a longer word).
            const re = new RegExp(WB_PRE + escapeRegex(qNorm) + WB_POST, 'u');
            return re.test(t) || re.test(d);
        }
        if (exactPhrase) {
            return t.includes(qNorm) || d.includes(qNorm);
        }
        for (const token of tokens) {
            const tok = hay => wholeWord
                ? new RegExp(WB_PRE + escapeRegex(token) + WB_POST, 'u').test(hay)
                : hay.includes(token);
            if (!tok(t) && !tok(d)) return false;
        }
        return true;
    }

    currentMatches = entries.filter(e => entryMatches(e.term, e.definition.join(' ')));
    const count = currentMatches.length;
    countEl.textContent = `${count.toLocaleString()} match${count !== 1 ? 'es' : ''} for "${query}"`;

    // For exact-phrase mode, highlight only the full phrase as one unit.
    // For normal mode, highlight each individual token.
    const hlTokens = exactPhrase ? [qNorm] : tokens;
    renderResults(currentMatches, hlTokens, wholeWord);
    // Reset find state
    closeFind(true);
}

// Shared word-boundary definition: used by both the whole-word filters and
// the whole-word highlighter, so they can't disagree about what a "word" is.
const WB_PRE = '(?<![\\w\u0590-\u05ff\ufb1d-\ufb4f])';
const WB_POST = '(?![\\w\u0590-\u05ff\ufb1d-\ufb4f])';

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dictionaries: which are pressed, which are available ──────────────────────
// YCD and JNW are always available. EYD (the English-Yiddish dictionary) is
// reached through a private relay and only appears while that relay answers.
const DICTS = ['ycd', 'jnw', 'ceyd'];
let dictOn = {ycd: true, jnw: true, ceyd: true};   // what the user has pressed
let ceydAvailable = false;                            // is the relay reachable right now?
let ceydReason = '';                                  // why the last check failed (shown in Settings)
let relayCanFetch = false;                            // does the relay also offer /api/fetch (used for JNW)?
let activeResultTab = 'ycd';
let scopeSearchTimer = null;

function enabledDicts() {
    const on = DICTS.filter(d => dictOn[d] && (d !== 'ceyd' || ceydAvailable));
    return on.length ? on : ['ycd'];
}

function loadDictState() {
    try {
        const saved = JSON.parse(localStorage.getItem('dictSet') || 'null');
        if (saved && typeof saved === 'object') {
            for (const d of DICTS) if (typeof saved[d] === 'boolean') dictOn[d] = saved[d];
            return;
        }
        const old = localStorage.getItem('dictScope');   // from before there were three dictionaries
        if (old === 'ycd') dictOn.jnw = false;
        if (old === 'jnw') dictOn.ycd = false;
    } catch (e) {
    }
}

// Update columns, buttons and tabs to match the current state (no search).
function refreshDictUI() {
    if (!DICTS.some(d => dictOn[d] && (d !== 'ceyd' || ceydAvailable))) dictOn.ycd = true;
    const enabled = enabledDicts();
    for (const d of DICTS) {
        document.getElementById('col-' + d).classList.toggle('hidden-col', !enabled.includes(d));
    }
    try {
        localStorage.setItem('dictSet', JSON.stringify(dictOn));
    } catch (e) {
    }
    syncScopeUI();
}

function applyDictScope() {
    refreshDictUI();
    // Re-run the current search (if any) under the new selection. Wait until the
    // browser has painted the button/tab change first, so a press is acknowledged
    // before the (possibly slow) search starts. Rapid presses collapse into one search.
    clearTimeout(scopeSearchTimer);
    requestAnimationFrame(() => {
        scopeSearchTimer = setTimeout(doSearch, 0);
    });
}

// At least one available dictionary always stays pressed.
function toggleDict(which) {
    const next = {...dictOn, [which]: !dictOn[which]};
    if (!DICTS.some(d => next[d] && (d !== 'ceyd' || ceydAvailable))) return;
    dictOn = next;
    applyDictScope();
}

function showResultTab(which) {
    activeResultTab = which;
    syncScopeUI();
    // Find only looks at the visible dictionary, so refresh it for the new tab.
    if (document.getElementById('findbar').classList.contains('open')) findReset();
}

// Reflect the selection in the buttons, and set up the phone tabs.
function syncScopeUI() {
    const enabled = enabledDicts();
    if (!enabled.includes(activeResultTab)) activeResultTab = enabled[0];
    document.getElementById('toggle-ceyd').hidden = !ceydAvailable;
    document.getElementById('results-columns').classList.toggle('tabs-on', enabled.length >= 2);
    for (const d of DICTS) {
        const on = enabled.includes(d);
        document.getElementById('toggle-' + d).setAttribute('aria-pressed', String(on));
        const tab = document.getElementById('tab-' + d);
        tab.hidden = !on;
        const isActive = activeResultTab === d;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        document.getElementById('col-' + d).classList.toggle('active-tab', isActive);
    }
}

// Mirror each column's result count (just the number) into its phone tab.
function setupTabCounts() {
    for (const d of DICTS) {
        const src = document.getElementById('count-' + d);
        const dst = document.getElementById('tabcount-' + d);
        const update = () => {
            const m = /^([\d,]+)(?: of [\d,]+)? (?:fetched )?match/.exec(src.textContent.trim());
            dst.textContent = m ? m[1] : '';
        };
        new MutationObserver(update).observe(src, {childList: true, characterData: true, subtree: true});
        update();
    }
}

// ── EYD (English-Yiddish dictionary) via the private relay ────────────────────
// The address typed in Settings. Blank when this page is served by the Pi itself.
function getSavedCeydUrl() {
    try {
        return (localStorage.getItem('ceydRelayUrl') || '').trim().replace(/\/+$/, '');
    } catch (e) {
        return '';
    }
}

// The relay to use: the saved address or, on a page the relay serves itself
// (it adds window.PI_HOSTED), that same server.
function getCeydUrl() {
    return getSavedCeydUrl() || (window.PI_HOSTED ? window.location.origin : '');
}

function ceydTranslit() {
    try {
        return localStorage.getItem('ceydTranslit') === '1';
    } catch (e) {
        return false;
    }
}

function ceydStatusText() {
    if (!getCeydUrl()) return 'Not set up. EYD stays hidden.';
    if (ceydAvailable) return window.PI_HOSTED && !getSavedCeydUrl() ? 'Connected. This page is served by your Pi.' : 'Connected.';
    return `Can't reach the relay (${ceydReason || 'is Tailscale on?'}). EYD stays hidden until it can.`;
}

// Ask the relay whether it is there. Fails quietly (and EYD stays hidden) when it isn't.
async function checkCeyd() {
    const base = getCeydUrl();
    let ok = false;
    let canFetch = false;
    ceydReason = '';
    if (base) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(base + '/api/ping', {signal: ctrl.signal, cache: 'no-store'});
            if (!r.ok) {
                ceydReason = `the relay answered HTTP ${r.status}` + (r.status === 404 ? ' - is it updated and restarted?' : '');
            } else {
                const j = await r.json();
                ok = j.ok === true && (j.service === 'dictionary-relay' || j.service === 'ceyd-relay');
                canFetch = ok && Array.isArray(j.features) && j.features.includes('fetch');
                if (!ok) ceydReason = 'unexpected reply from that address';
            }
        } catch (e) {
            ceydReason = e.name === 'AbortError'
                ? 'no answer within 4 seconds - is Tailscale on?'
                : 'blocked or unreachable - not on Tailscale, or the browser refused the cross-site request';
        }
        clearTimeout(timer);
    }
    const changed = ok !== ceydAvailable;
    ceydAvailable = ok;
    relayCanFetch = canFetch;
    if (changed) {
        refreshDictUI();
        const query = document.getElementById('search-input').value.trim();
        if (ok && query && enabledDicts().includes('ceyd')) searchCeyd(query);
        else if (ok) showCeydStatus();
    }
    const st = document.getElementById('ceyd-status');
    if (st) st.textContent = ceydStatusText();
    return ok;
}

window.addEventListener('online', checkCeyd);
window.addEventListener('offline', () => {
    if (ceydAvailable) {
        ceydAvailable = false;
        refreshDictUI();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkCeyd();
});

// Like JNW's status line: shown before a search and while one is running, then
// replaced by the match count.
function showCeydStatus() {
    document.getElementById('count-ceyd').textContent = 'searching remote database';
}

let ceydToken = 0;

async function searchCeyd(query, opts = {}) {
    const container = document.getElementById('results-ceyd');
    const countEl = document.getElementById('count-ceyd');
    const token = ++ceydToken;
    showCeydStatus();
    if (!query) {
        container.innerHTML = '<p class="message">Type a word and tap Search.</p>';
        return;
    }
    container.innerHTML = '<p class="message"><span class="spinner"></span> Searching EYD…</p>';
    const p = new URLSearchParams({q: query, lang: opts.lang || 'auto', translit: ceydTranslit() ? '1' : '0'});
    if (opts.id) p.set('id', opts.id);
    if (opts.extend) p.set('extend', '1');
    try {
        const r = await fetch(getCeydUrl() + '/api/search?' + p, {cache: 'no-store'});
        const d = await r.json();
        if (token !== ceydToken) return;
        if (!r.ok) throw new Error(d.error || r.status);
        renderCeyd(d, container, countEl);
    } catch (e) {
        if (token !== ceydToken) return;
        countEl.textContent = '';
        container.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'jnw-fallback';
        div.textContent = "Couldn't search the English-Yiddish dictionary: " + e.message;
        container.append(div);
    }
}

function renderCeyd(d, container, countEl) {
    container.textContent = '';
    const real = d.choices.filter(c => !c.more);
    if (!d.entries.length) {
        container.innerHTML = '<p class="message">No matches found.</p>';
        countEl.textContent = '';
        return;
    }
    countEl.textContent = `${real.length.toLocaleString()} match${real.length !== 1 ? 'es' : ''} for "${d.query}"`;
    if (d.choices.length) {
        const wrap = document.createElement('div');
        wrap.className = 'ceyd-choices';
        let sepDone = false;
        for (const c of d.choices) {
            if (!c.top && !sepDone && d.choices.some(x => x.top)) {
                sepDone = true;
                const sep = document.createElement('div');
                sep.className = 'ceyd-sep';
                wrap.append(sep);
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ceyd-chip' + (c.top ? ' top' : '') + (c.selected ? ' sel' : '');
            b.textContent = c.more ? 'More…' : c.label;
            b.onclick = () => searchCeyd(d.query, {lang: d.lang, id: c.id, extend: c.extend});
            wrap.append(b);
        }
        container.append(wrap);
        const sel = wrap.querySelector('.sel');
        if (sel) wrap.scrollTop = Math.max(0, sel.offsetTop - 8);
    }
    for (const rows of d.entries) {
        const entry = document.createElement('div');
        entry.className = 'entry';
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'ceyd-row' + (r.sub ? ' sub' : '');
            const en = document.createElement('div');
            en.className = 'term';
            en.innerHTML = r.en;
            row.append(en);
            if (r.yi || r.tr) {
                const yi = document.createElement('div');
                yi.className = 'defpara';
                yi.innerHTML = r.yi;
                if (r.tr) {
                    const tr = document.createElement('span');
                    tr.className = 'ceyd-tr';
                    tr.textContent = r.tr;
                    yi.append(tr);
                }
                row.append(yi);
            }
            entry.append(row);
        }
        container.append(entry);
    }
    const src = document.createElement('div');
    src.className = 'col-count';
    src.style.textAlign = 'center';
    src.textContent = '© Comprehensive English-Yiddish Dictionary';
    container.append(src);
}

// Settings for EYD
function syncCeydSettings() {
    const urlInput = document.getElementById('ceyd-url-input');
    urlInput.value = getSavedCeydUrl();
    if (window.PI_HOSTED) urlInput.placeholder = 'Leave blank: this page is served by your Pi';
    document.getElementById('ceyd-translit').checked = ceydTranslit();
    document.getElementById('ceyd-status').textContent = ceydStatusText();
}

async function saveCeydUrl() {
    const input = document.getElementById('ceyd-url-input');
    let v = input.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
        localStorage.setItem('ceydRelayUrl', v);
    } catch (e) {
    }
    input.value = v;
    document.getElementById('ceyd-status').textContent = 'Checking…';
    await checkCeyd();
}

function clearCeydUrl() {
    try {
        localStorage.removeItem('ceydRelayUrl');
    } catch (e) {
    }
    document.getElementById('ceyd-url-input').value = '';
    ceydAvailable = false;
    refreshDictUI();
    document.getElementById('ceyd-status').textContent = ceydStatusText();
    if (window.PI_HOSTED) checkCeyd();   // this server is still the relay
}

function setCeydTranslit(on) {
    try {
        localStorage.setItem('ceydTranslit', on ? '1' : '0');
    } catch (e) {
    }
    const query = document.getElementById('search-input').value.trim();
    if (query && enabledDicts().includes('ceyd')) searchCeyd(query);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderResults(entries, tokens, wholeWord = false) {
    const container = document.getElementById('results-ycd');
    if (!entries.length) {
        container.innerHTML = '<p class="message">No matches found.</p>';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of entries) {
        const div = document.createElement('div');
        div.className = 'entry';

        // Term
        const termDiv = document.createElement('div');
        termDiv.className = 'term';
        termDiv.innerHTML = highlightTokens(bidiTermDisplay(entry.term), tokens, wholeWord);
        div.appendChild(termDiv);

        // Definition paragraphs
        for (const para of entry.definition) {
            const p = document.createElement('div');
            p.className = 'defpara';
            p.innerHTML = highlightTokens(para, tokens, wholeWord);
            div.appendChild(p);
        }

        frag.appendChild(div);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

function highlightTokens(text, tokens, wholeWord = false) {
    if (!tokens || !tokens.length) return escapeHTML(text);

    // Find match positions against the normalized text (so e.g. ײ/יי and
    // בֿ/ב are treated as equivalent when matching), but keep a map back to
    // the original text so the HTML we build preserves whatever the
    // original characters actually were (e.g. a rafe diacritic that
    // normalization would otherwise have discarded).
    const {normalized, chunks} = normalizeYiddishWithMap(text);
    const lower = normalized.toLowerCase();
    const ranges = [];
    for (const token of tokens) {
        if (wholeWord) {
            // Only highlight occurrences bounded by non-word characters, matching
            // the whole-word filter used when selecting results.
            const re = new RegExp(WB_PRE + escapeRegex(token) + WB_POST, 'gu');
            let m;
            while ((m = re.exec(lower)) !== null) {
                ranges.push([m.index, m.index + m[0].length]);
                if (m[0].length === 0) re.lastIndex++;
            }
        } else {
            let pos = 0;
            while (true) {
                const idx = lower.indexOf(token, pos);
                if (idx === -1) break;
                ranges.push([idx, idx + token.length]);
                pos = idx + token.length;
            }
        }
    }
    if (!ranges.length) return escapeHTML(text);

    // Map each normalized-coordinate range to original-text coordinates.
    // If a match only partially overlaps a chunk (e.g. it lands on just one
    // of the two characters an expanded ligature produced), we round
    // outward to the whole original character(s) that chunk came from,
    // since a single original character can't be half-highlighted.
    const origRanges = ranges.map(([s, e]) => {
        const startChunk = findChunkForNormIndex(chunks, s);
        const endChunk = findChunkForNormIndex(chunks, e - 1);
        return [startChunk.origStart, endChunk.origEnd];
    });

    // Merge overlapping ranges (now in original-text coordinates; rounding
    // outward above can occasionally cause new overlaps)
    origRanges.sort((a, b) => a[0] - b[0]);
    const merged = [origRanges[0]];
    for (const [s, e] of origRanges.slice(1)) {
        if (s <= merged[merged.length - 1][1])
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
        else merged.push([s, e]);
    }

    // Build HTML from the ORIGINAL text, not the normalized text
    let html = '', pos = 0;
    for (const [s, e] of merged) {
        if (s > pos) html += escapeHTML(text.slice(pos, s));
        html += `<mark>${escapeHTML(text.slice(s, e))}</mark>`;
        pos = e;
    }
    if (pos < text.length) html += escapeHTML(text.slice(pos));
    return html;
}

function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── JNW live search (jiddischwoordenboek.nl) ────────────────────────────────
// JNW's site is a client-rendered Vue app, but it's backed by a JSON search
// API that the app itself calls (found by inspecting the Network tab):
//   https://jiddischwoordenboek.nl/api/search?q.all_zoek=<query>&start=0&rows=<n>
// We call that directly rather than scraping the rendered page.
let jnwSearchToken = 0;
const JNW_ROWS = 200; // how many hits to request per page (server appears to actually cap real page size around 100)
const JNW_LIVE_FETCH_CAP = 500; // live search pages up to this many total results before stopping, to balance completeness vs speed

function jnwApiUrl(query, start = 0, rows = JNW_ROWS) {
    return `https://jiddischwoordenboek.nl/api/search?q.all_zoek=${encodeURIComponent(query)}&start=${start}&rows=${rows}`;
}

function jnwWebUrl(query) {
    // A link a person can open in a browser to see the same search on JNW itself.
    return `https://jiddischwoordenboek.nl/?zoek=${encodeURIComponent(query)}`;
}

async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, {...opts, signal: ctrl.signal});
    } finally {
        clearTimeout(timer);
    }
}

// Try a direct fetch, then a chain of public CORS proxies (each capped with
// its own timeout so one slow/dead proxy doesn't stall the whole search).
// Proxies come and go, so having more than one to fall back to matters.
async function fetchWithCorsFallback(url) {
    const attempts = [
        {name: 'direct', fetch: () => fetchWithTimeout(url, {headers: {'Accept': 'application/json'}}, 8000)},
        {
            name: 'allorigins',
            fetch: () => fetchWithTimeout(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {}, 9000)
        },
        {
            name: 'codetabs',
            fetch: () => fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, {}, 9000)
        },
        {
            name: 'corsproxy.io',
            fetch: () => fetchWithTimeout(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, {}, 9000)
        },
    ];

    // The Pi relay (when it's reachable and offers /api/fetch) goes right after the direct
    // attempt, ahead of the public proxies: same job, but it's yours and doesn't come and go.
    if (ceydAvailable && relayCanFetch) {
        attempts.splice(1, 0, {
            name: 'Pi relay',
            fetch: () => fetchWithTimeout(`${getCeydUrl()}/api/fetch?url=${encodeURIComponent(url)}`,
                {headers: {'X-Target-Accept': 'application/json'}}, 12000)
        });
    }

    // A route only counts if what came back looks like JNW's JSON. Otherwise (a block page,
    // an HTML shell, a proxy's error page with a 200) the next route gets its turn. If no
    // route returns JSON, the first odd response is still handed back, so the "couldn't
    // parse" panel can show what was received.
    const looksLikeJnwJson = text => {
        try {
            const data = JSON.parse(text);
            return !!data && Array.isArray(data.results) && !!data.summary;
        } catch (e) {
            return false;
        }
    };

    const errors = [];
    let oddResponse = null;
    for (const attempt of attempts) {
        try {
            const resp = await attempt.fetch();
            if (!resp.ok) {
                let why = `HTTP ${resp.status}`;
                if (attempt.name === 'Pi relay') {        // the relay says why in its JSON body
                    try {
                        const j = await resp.clone().json();
                        if (j && j.error) why += ` (${j.error})`;
                    } catch (e) {
                    }
                }
                throw new Error(why);
            }
            const text = await resp.text();
            if (!text) throw new Error('empty response');
            if (!looksLikeJnwJson(text)) {
                if (!oddResponse) oddResponse = {name: attempt.name, text};
                throw new Error('not JNW JSON');
            }
            fetchWithCorsFallback.lastVia = attempt.name; // diagnostic only — which channel actually served this
            return text;
        } catch (err) {
            const msg = err.name === 'AbortError' ? 'timed out' : err.message;
            errors.push(`${attempt.name}: ${msg}`);
        }
    }
    if (oddResponse) {
        fetchWithCorsFallback.lastVia = oddResponse.name;
        return oddResponse.text;
    }
    throw new Error(errors.join('; '));
}

// Pages live JNW search results up to `cap` total entries, advancing by
// however many the server actually returns per page (see the crawl code
// above for why — it caps real page size well below what `rows` requests).
// Cache-busted for the same reason the crawl is: proxies can serve stale
// pages otherwise. Stops early on error/parse-failure after the first page
// so a flaky later page doesn't blank out results we already have.
async function fetchJNWLivePaged(query, cap) {
    let start = 0;
    let numFound = null;
    const all = [];
    let firstPageError = null;
    let firstPageParseFailed = null;

    while (true) {
        const url = jnwApiUrl(query, start, JNW_ROWS) + `&_cb=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let raw;
        try {
            raw = await fetchWithCorsFallback(url);
        } catch (err) {
            if (start === 0) firstPageError = err;
            break;
        }

        let parsed;
        try {
            parsed = parseJNWApiResponse(raw);
        } catch (e) {
            parsed = null;
        }
        if (!parsed) {
            if (start === 0) firstPageParseFailed = raw;
            break;
        }

        numFound = parsed.numFound;
        all.push(...parsed.entries);
        const pageSize = parsed.entries.length;
        if (pageSize === 0 || all.length >= numFound || all.length >= cap) break;
        start += pageSize;
        await new Promise(r => setTimeout(r, 150)); // small courtesy pause between pages
    }

    return {entries: all, numFound: numFound ?? all.length, firstPageError, firstPageParseFailed};
}

// What the JNW count line says when it isn't showing match counts: which
// source the next search will use (like YCD's "N entries loaded").
let jnwCountShowsStatus = true;

function jnwSourceStatus() {
    const n = Array.isArray(window._jnwBackupEntries) ? window._jnwBackupEntries.length : 0;
    if (jnwOfflineModeActive() || (navigator.onLine === false && n > 0)) {
        return `${n.toLocaleString()} entries loaded (offline backup)`;
    }
    if (navigator.onLine === false) return 'no internet connection';
    return 'searching remote database';
}

function showJNWStatus() {
    document.getElementById('count-jnw').textContent = jnwSourceStatus();
    jnwCountShowsStatus = true;
}

function clearJNWCount() {
    document.getElementById('count-jnw').textContent = '';
    jnwCountShowsStatus = false;
}

async function searchJNW(query, opts = {}) {
    const {wholeWord = false, exactPhrase = false, displayAll = false} = opts;
    const token = ++jnwSearchToken; // lets a newer search cancel an older, in-flight one
    const container = document.getElementById('results-jnw');
    const countEl = document.getElementById('count-jnw');

    if (!query) {
        container.innerHTML = '<p class="message">Type a word and tap Search.</p>';
        showJNWStatus();
        return;
    }

    container.innerHTML = '<p class="message"><span class="spinner"></span> Searching JNW…</p>';
    showJNWStatus();

    const webUrl = jnwWebUrl(query);
    // Use the local backup if the person turned on offline mode in Settings,
    // or automatically when the device reports no connection. (If the device
    // *claims* to be online but JNW can't be reached, there's a second
    // fallback below.)
    const hasBackup = Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length > 0;
    let offline = jnwOfflineModeActive();
    let autoNote = '';
    if (!offline && navigator.onLine === false) {
        if (hasBackup) {
            offline = true;
            autoNote = 'no internet connection';
        } else {
            container.innerHTML = '<div class="jnw-fallback">No internet connection, and no local JNW backup is loaded. ' +
                'Import or crawl a backup in Settings to search JNW offline.</div>';
            clearJNWCount();
            return;
        }
    }

    let entries, numFound;

    if (offline) {
        ({entries, numFound} = searchJNWLocalBackup(query));
    } else {
        const result = await fetchJNWLivePaged(query, JNW_LIVE_FETCH_CAP);
        if (token !== jnwSearchToken) return; // a newer search superseded this one

        if (result.firstPageError && hasBackup) {
            // Navigator said "online" but JNW (and every proxy) failed — e.g.
            // captive portal, bad signal. Fall back to the local backup.
            offline = true;
            autoNote = "couldn't reach JNW";
            ({entries, numFound} = searchJNWLocalBackup(query));
        } else {
            if (result.firstPageError) {
                container.innerHTML = `<div class="jnw-fallback">Couldn't reach JNW (${escapeHTML(result.firstPageError.message)}).
        <a href="${webUrl}" target="_blank" rel="noopener">Search on jiddischwoordenboek.nl ↗</a></div>`;
                clearJNWCount();
                return;
            }

            if (result.firstPageParseFailed) {
                // Couldn't confidently parse the response — don't guess. Show a link
                // out, plus the raw text we actually received so this can be fixed
                // without needing browser dev tools.
                const raw = result.firstPageParseFailed;
                const preview = raw.length > 8000 ? raw.slice(0, 8000) + '\n…(truncated)' : raw;
                container.innerHTML = `<div class="jnw-fallback">Couldn't parse JNW's response.
        <a href="${webUrl}" target="_blank" rel="noopener">Open the search on jiddischwoordenboek.nl ↗</a>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;">Show raw response received (for debugging)</summary>
          <textarea readonly style="width:100%;height:200px;font-size:10px;margin-top:6px;" onclick="this.select()">${escapeHTML(preview)}</textarea>
        </details></div>`;
                clearJNWCount();
                return;
            }

            ({entries, numFound} = result);
        }
    }

    const offlineSuffix = offline ? (autoNote ? ` (offline backup — ${autoNote})` : ' (offline backup)') : '';

    // JNW's own API has no "whole word" / "exact phrase" options, and its
    // own matching logic is broader than a literal headword match (it seems
    // to also match on other fields and/or do fuzzy matching). So unless
    // "Display all" is checked, we always filter down to entries whose
    // headword (trefwoord) literally contains the searched sequence — this
    // is the JNW-side default now. If "Whole word" is also checked, that
    // filter is additionally required to land on word boundaries (which,
    // combined with the phrase-adjacency the default already requires, is
    // the same "both conditions together" combination used on the YCD side).
    // Always run through the ranker so main-term matches come first; with
    // "Display all", non-matching entries are kept too (listed last).
    const filtered = filterJNWEntriesByTerm(entries, query, {wholeWord, keepAll: displayAll});

    const fetchedNote = entries.length < numFound ? ` (${numFound.toLocaleString()} total on JNW)` : '';

    // Same tokenization approach as YCD's highlighter, so the same searched
    // word(s) get highlighted in JNW's results too.
    const qNormJ = normalizeYiddish(query.toLowerCase());
    const tokensJ = qNormJ.split(/\s+/).filter(Boolean);
    const hlTokensJ = exactPhrase ? [qNormJ] : tokensJ;

    if (!filtered.length) {
        container.innerHTML = '<p class="message">No matches found.</p>';
        jnwCountShowsStatus = false;
        countEl.textContent = (displayAll
            ? `0 matches for "${query}"`
            : `0 of ${entries.length.toLocaleString()} fetched match${entries.length !== 1 ? 'es' : ''}${fetchedNote}`) + offlineSuffix;
        return;
    }

    const shown = filtered.length < entries.length
        ? `${filtered.length.toLocaleString()} of ${entries.length.toLocaleString()} fetched match${entries.length !== 1 ? 'es' : ''}${fetchedNote}`
        : (filtered.length < numFound
            ? `${filtered.length.toLocaleString()} of ${numFound.toLocaleString()} matches shown`
            : `${filtered.length.toLocaleString()} match${filtered.length !== 1 ? 'es' : ''} for "${query}"`);
    jnwCountShowsStatus = false;
    countEl.textContent = shown + offlineSuffix;

    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
        const div = document.createElement('div');
        div.className = 'jnw-entry';

        const row = document.createElement('div');
        row.className = 'jnw-term-row';
        const term = document.createElement('span');
        term.className = 'jnw-term';
        term.innerHTML = highlightTokens(entry.term, hlTokensJ, wholeWord) + (entry.toevoeg ? ` (${escapeHTML(entry.toevoeg)})` : '');
        row.appendChild(term);
        if (entry.href) {
            const a = document.createElement('a');
            a.className = 'jnw-open';
            a.href = entry.href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'JNW ↗';
            row.appendChild(a);
        }
        div.appendChild(row);

        if (entry.belongsTo && entry.belongsTo.length) {
            const bel = document.createElement('div');
            bel.className = 'jnw-belongs';
            bel.innerHTML = 'belongs to: ' + entry.belongsTo
                .map(b => `<span class="jnw-belongs-term">${highlightTokens(b, hlTokensJ, wholeWord)}</span>`)
                .join(', ');
            div.appendChild(bel);
        }
        if (entry.meta) {
            const meta = document.createElement('div');
            meta.className = 'jnw-meta';
            meta.innerHTML = entry.meta;
            div.appendChild(meta);
        }
        if (entry.kenmerk) {
            const kenmerk = document.createElement('div');
            kenmerk.className = 'jnw-kenmerk';
            kenmerk.textContent = `character: ${entry.kenmerk}`;
            div.appendChild(kenmerk);
        }
        if (entry.translation) {
            const trans = document.createElement('div');
            trans.className = 'jnw-snippet';
            trans.innerHTML = highlightTokens(entry.translation, hlTokensJ, wholeWord);
            div.appendChild(trans);
        }
        if (entry.seeAlso && entry.seeAlso.length) {
            const see = document.createElement('div');
            see.className = 'jnw-seealso';
            see.innerHTML = 'see also: ' + entry.seeAlso
                .map(x => `<span class="jnw-seealso-term">${highlightTokens(x, hlTokensJ, wholeWord)}</span>`)
                .join(' · ');
            div.appendChild(see);
        }
        if (entry.examples && entry.examples.length) {
            const box = document.createElement('div');
            box.className = 'jnw-examples';
            let html = `<div class="jnw-examples-label">Examples (${entry.examples.length})</div>`;
            for (const ex of entry.examples) {
                html += '<div class="jnw-example">' +
                    `<div class="jnw-ex-phrase">${highlightTokens(ex.phrase, hlTokensJ, wholeWord)}</div>` +
                    (ex.pron ? `<div class="jnw-ex-pron">${formatJNWMarkup(ex.pron)}</div>` : '') +
                    (ex.translation ? `<div class="jnw-ex-trans">${highlightTokens(ex.translation, hlTokensJ, wholeWord)}</div>` : '') +
                    (ex.seeAlso ? `<div class="jnw-ex-see">see also: <span>${highlightTokens(ex.seeAlso, hlTokensJ, wholeWord)}</span></div>` : '') +
                    '</div>';
            }
            box.innerHTML = html;
            div.appendChild(box);
        }
        frag.appendChild(div);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

// Filters JNW entries client-side against their headword (trefwoord),
// since JNW's own matching is broader than a literal headword match and
// its API doesn't support whole-word/exact-phrase options. Called for
// every search unless "Display all" is checked (see searchJNW).
function filterJNWEntriesByTerm(entries, query, {wholeWord, keepAll = false}) {
    // Strip bidi control marks (e.g. U+200F RLM, which JNW embeds in some
    // trefwoord_naklik values) and collapse the resulting whitespace runs
    // down to single spaces, so a plain-typed query matches an entry whose
    // multi-part term has one of these invisible marks sitting between words.
    const clean = s => s.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();

    const qNorm = clean(normalizeYiddish(query.toLowerCase()));

    // The baseline (always applied unless "Display all" is checked) requires
    // the searched words to appear adjacent and in order in the headword —
    // i.e. the old "Exact phrase" behavior. "Whole word" strengthens that
    // same adjacent-phrase match by also requiring word boundaries at its
    // start and end, so it can't be embedded inside a longer word.
    const re = wholeWord
        ? new RegExp(WB_PRE + escapeRegex(qNorm) + WB_POST, 'u')
        : null;

    const norm = x => clean(normalizeYiddish(String(x || '').toLowerCase()));
    const hits = t => wholeWord ? re.test(t) : t.includes(qNorm);
    const anyHit = arr => arr.some(x => hits(norm(x)));

    // Ranking — lower comes first:
    //   0  the main term matches and the entry is a real headword (no belongsTo)
    //   1  the main term matches but it's a phrase that belongs to another keyword
    //   2  the keyword a phrase "belongs to" matches
    //   3  a see-also (doorverw) term matches, on the entry or on one of its examples
    //   4  no match at all (only kept when "Display all" is checked)
    // Entries keep JNW's own order within each rank (the sort is stable).
    const rankOf = e => {
        const isPhrase = (e.belongsTo || []).length > 0;
        if (hits(norm(e.term))) return isPhrase ? 1 : 0;
        if (anyHit(e.belongsTo || [])) return 2;
        if (anyHit(e.seeAlso || []) || anyHit((e.examples || []).map(x => x.seeAlso || '').filter(Boolean))) return 3;
        return 4;
    };

    return entries
        .map((e, i) => ({e, i, r: rankOf(e)}))
        .filter(x => keepAll || x.r < 4)
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(x => x.e);
}

// Parses a response from https://jiddischwoordenboek.nl/api/search, whose
// shape is: { summary: { numFound, ... }, results: [ { trefwoord,
// trefwoord_naklik, uitspraak, uitspraak_naklik, vert_zoek, toevoeg,
// kenmerk, url, ... }, ... ] }
// Returns { entries, numFound } — entries may be empty (genuinely no
// matches) — or null if the response wasn't recognized as this API's shape
// at all (so the caller can fall back to a plain link instead of guessing).

// JNW marks up some text (in `uitspraak`/`uitspraak_naklik`) with [u]...[/u]
// to mean bold+underline. This converts that into safe HTML (escaping
// everything else first, so no other tag/markup in the source can sneak
// through).
function formatJNWMarkup(s) {
    const parts = s.split(/(\[u\]|\[\/u\])/);
    let html = '';
    let open = false;
    for (const part of parts) {
        if (part === '[u]') {
            html += '<b><u>';
            open = true;
        } else if (part === '[/u]') {
            html += '</u></b>';
            open = false;
        } else html += escapeHTML(part);
    }
    if (open) html += '</u></b>'; // close an unterminated tag defensively
    return html;
}

// A JNW field may come back as a plain string or as an array of strings
// (both shapes have been observed across different fields); this normalizes
// either into one display string.
// JNW's own top-level `kenmerk` field isn't present on search-result hits;
// it's only found embedded inside the `xml` field, a string containing the
// full raw <artikel>...<trefregel><kenmerk>...</kenmerk>...</trefregel>
// XML for that entry. DOMParser handles entity-decoding/escaping correctly,
// which a regex wouldn't reliably do.
function extractKenmerkFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return '';
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return '';
        return doc.querySelector('kenmerk')?.textContent?.trim() || '';
    } catch (e) {
        return '';
    }
}

// A parent entry's example phrases (<voorbeeldregel> elements) aren't
// separate top-level fields on a search hit; like kenmerk they only exist
// inside the `xml` string. Each has: voorbeeld (the phrase, with "~"
// standing for the headword), uitspraak, vert_zoek/vertaling, and
// sometimes doorverw (a "see also" pointer to another phrase).
function extractExamplesFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return [];
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        const txt = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
        return Array.from(doc.querySelectorAll('voorbeeldregel')).map(el => ({
            phrase: txt(el, 'voorbeeld'),
            pron: txt(el, 'uitspraak'),
            // vert_zoek is the same text without [b]/[br] markup
            translation: txt(el, 'vert_zoek') || txt(el, 'vertaling').replace(/\[br\]/g, ' ').replace(/\[\/?b\]/g, ''),
            seeAlso: txt(el, 'doorverw'),
        })).filter(x => x.phrase);
    } catch (e) {
        return [];
    }
}

function extractSeeAlsoFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return [];
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        return Array.from(doc.querySelectorAll('trefregel > doorverw')).map(el => el.textContent.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function jnwFieldText(v) {
    if (Array.isArray(v)) return v.filter(Boolean).join(' ');
    if (typeof v === 'string') return v.trim();
    return '';
}

function parseJNWApiResponse(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return null;
    }
    if (!data || !Array.isArray(data.results) || !data.summary) return null;

    const numFound = Number(data.summary.numFound) || 0;
    const entries = [];
    for (const r of data.results) {
        const trefwoordText = jnwFieldText(r.trefwoord) || jnwFieldText(r.title);
        if (!trefwoordText) continue;

        // trefwoord_naklik (not always present) is displayed as a continuation
        // of trefwoord, not as a separate field.
        const trefNaklikText = jnwFieldText(r.trefwoord_naklik);
        const term = [trefwoordText, trefNaklikText].filter(Boolean).join(' ');

        const toevoeg = Array.isArray(r.toevoeg) ? r.toevoeg.join(', ') : '';

        // hoort_bij_trefwoord (present on example phrases / sub-entries such as
        // "~ אין האַרצן") lists the headword(s) the phrase belongs to — the "~"
        // stands for that headword.
        const belongsTo = (Array.isArray(r.hoort_bij_trefwoord) ? r.hoort_bij_trefwoord : (typeof r.hoort_bij_trefwoord === 'string' ? [r.hoort_bij_trefwoord] : []))
            .map(x => String(x).replace(/[\u200e\u200f]/g, '').trim()).filter(Boolean);

        // kenmerk (not always present) — a short grammatical/usage tag JNW
        // attaches to some entries. Not a top-level field on search hits; it's
        // embedded inside the `xml` field, so it's pulled out from there.
        const kenmerk = extractKenmerkFromXml(r.xml);
        const examples = extractExamplesFromXml(r.xml);

        // doorverw ("see also"): top-level array of related headwords/phrases.
        // Fall back to the entry's own <trefregel><doorverw> elements in the xml
        // (example phrases' own doorverw are handled separately, per example).
        let seeAlso = Array.isArray(r.doorverw) ? r.doorverw : (typeof r.doorverw === 'string' ? [r.doorverw] : []);
        if (!seeAlso.length) seeAlso = extractSeeAlsoFromXml(r.xml);
        seeAlso = seeAlso.map(x => String(x).replace(/[\u200e\u200f]/g, '').trim()).filter(Boolean);

        // uitspraak_naklik (not always present) is displayed as a continuation
        // of uitspraak, not as a separate field.
        const uitspraakText = Array.isArray(r.uitspraak) && r.uitspraak.length
            ? r.uitspraak.map(formatJNWMarkup).join('; ')
            : '';
        const naklikText = Array.isArray(r.uitspraak_naklik) && r.uitspraak_naklik.length
            ? r.uitspraak_naklik.map(formatJNWMarkup).join('; ')
            : '';
        const meta = [uitspraakText, naklikText].filter(Boolean).join(' ');

        const translation = Array.isArray(r.vert_zoek) ? r.vert_zoek.join('; ').replace(/\[br\]/g, ' ') : '';

        const href = r.url
            ? `https://jiddischwoordenboek.nl/api${r.url.startsWith('/') ? '' : '/'}${r.url}`
            : (r.pid ? `https://jiddischwoordenboek.nl/api/docs/${r.pid}` : null);

        entries.push({term, toevoeg, kenmerk, meta, translation, href, belongsTo, examples, seeAlso});
    }
    return {entries, numFound};
}

// ── JNW bulk backup (offline snapshot) ──────────────────────────────────────
// This is a *local backup tool*, separate from the live searchJNW() path
// above. It crawls the same public search API letter-by-letter (paging with
// `start`) to assemble a local snapshot in case jiddischwoordenboek.nl ever
// goes down. It is not wired into search — it only produces a downloadable
// JSON file.
const JNW_BASE_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ', 'ק', 'ר', 'ש', 'ת'];
const JNW_DIACRITIC_LETTERS = ['אַ', 'אָ', 'וּ', 'יִ', 'פּ', 'שׂ', 'תּ'];
const JNW_CRAWL_LETTERS = [...JNW_BASE_LETTERS, ...JNW_DIACRITIC_LETTERS];
const JNW_CRAWL_ROWS = 500; // rows per page for the backup crawl (live search still uses JNW_ROWS = 200)
const JNW_CRAWL_DELAY_MS = 350; // pause between requests to be polite to their server

let jnwCrawlCancelled = false;
let jnwCrawlRunning = false;
let jnwCrawlPauseResolve = null; // set while waiting on the user between letters

// ── Offline mode (search a locally stored backup instead of the live API) ──
let jnwBackupMeta = null;  // { source_name, crawled_date, entry_count } | null
let jnwOfflineMode = false; // whether searchJNW() should use the local backup

function jnwOfflineModeActive() {
    return jnwOfflineMode && Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length > 0;
}

function updateJNWOfflineUI() {
    const statusEl = document.getElementById('jnw-offline-status');
    const toggleEl = document.getElementById('jnw-offline-toggle');
    const clearBtn = document.getElementById('jnw-clear-backup-btn');
    const downloadBtn = document.getElementById('jnw-backup-download');
    const hasBackup = !!(jnwBackupMeta && Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length);

    if (hasBackup) {
        statusEl.textContent = `Local backup loaded: ${jnwBackupMeta.entry_count.toLocaleString()} entries` +
            (jnwBackupMeta.crawled_date ? ` (saved ${jnwBackupMeta.crawled_date})` : '');
        toggleEl.disabled = false;
        toggleEl.checked = jnwOfflineMode;
        clearBtn.disabled = false;
    } else {
        statusEl.textContent = 'No local backup loaded.';
        toggleEl.disabled = true;
        toggleEl.checked = false;
        clearBtn.disabled = true;
    }
    downloadBtn.disabled = !hasBackup;

    if (jnwCountShowsStatus) showJNWStatus();
}

// The YCD / JNW title links can't work without a connection, so grey them out.
function updateDictLinks() {
    const offline = navigator.onLine === false;
    document.querySelectorAll('a.dict-link').forEach(a => {
        a.style.pointerEvents = offline ? 'none' : '';
        a.style.opacity = offline ? '.45' : '';
        if (offline) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
}

// Connection changes alter which source a search would use.
window.addEventListener('online', () => {
    updateDictLinks();
    if (jnwCountShowsStatus) showJNWStatus();
});
window.addEventListener('offline', () => {
    updateDictLinks();
    if (jnwCountShowsStatus) showJNWStatus();
});
updateDictLinks();

function setJNWOfflineMode(on) {
    jnwOfflineMode = on;
    try {
        localStorage.setItem('jnwOfflineMode', on ? '1' : '0');
    } catch (e) {
    }
    updateJNWOfflineUI();
}

async function handleJNWBackupFile(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch (e) {
        alert('Could not read that file as JSON: ' + e.message);
        return;
    }
    if (!data || !Array.isArray(data.entries) || !data.entries.length) {
        alert('That file doesn\'t look like a JNW backup (expected an "entries" array).');
        return;
    }
    jnwBackupMeta = {
        source_name: data.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: data.crawled_date || '',
        entry_count: data.entries.length
    };
    window._jnwBackupEntries = data.entries;
    await saveJNWBackupToDB(jnwBackupMeta, data.entries);
    updateJNWOfflineUI();
}

async function clearJNWBackup() {
    window._jnwBackupEntries = [];
    jnwBackupMeta = null;
    await clearJNWBackupFromDB();
    setJNWOfflineMode(false); // also updates the UI
}

// Broad substring match across term/toevoeg/translation, mirroring how
// JNW's own live API returns a broader-than-headword candidate set before
// filterJNWEntriesByTerm narrows it down. Needed because, unlike the live
// API, a local backup search starts from literally every entry.
function searchJNWLocalBackup(query) {
    const qNorm = normalizeYiddish(query.toLowerCase()).trim();
    const all = window._jnwBackupEntries || [];
    const entries = all.filter(e => {
        const hay = normalizeYiddish(`${e.term || ''} ${(e.belongsTo || []).join(' ')} ${(e.seeAlso || []).join(' ')} ${(e.examples || []).map(x => x.seeAlso || '').join(' ')} ${e.toevoeg || ''} ${e.translation || ''}`.toLowerCase());
        return hay.includes(qNorm);
    });
    return {entries, numFound: entries.length};
}

function openSettings() {
    document.getElementById('settings-overlay').classList.add('open');
    refreshStatus();
    updateJNWOfflineUI();
    syncCeydSettings();
}

function closeSettings() {
    if (jnwCrawlRunning) jnwCrawlStop(); // don't leave a paused/running crawl unseen
    document.getElementById('settings-overlay').classList.remove('open');
}

function cancelJNWBackup() {
    jnwCrawlStop();
}

// Called from the "Continue to Next Letter" / "Stop Here" pause buttons.
function jnwCrawlContinue() {
    if (jnwCrawlPauseResolve) {
        const r = jnwCrawlPauseResolve;
        jnwCrawlPauseResolve = null;
        r(true);
    }
}

function jnwCrawlStop() {
    jnwCrawlCancelled = true;
    if (jnwCrawlPauseResolve) {
        const r = jnwCrawlPauseResolve;
        jnwCrawlPauseResolve = null;
        r(false);
    }
}

function waitForUserToContinue() {
    document.getElementById('jnw-backup-pause-btns').style.display = 'flex';
    return new Promise(resolve => {
        jnwCrawlPauseResolve = resolve;
    });
}

// Crawls one query term (a letter + '*') to exhaustion, paging with `start`,
// merging results into the given Map (dedupe key: href, else
// term|toevoeg|translation). Shared by the full multi-letter crawl and the
// single-letter tool below. Returns { gotThisLetter, addedThisLetter, numFound }.
async function crawlOneLetterIntoMap(letter, seenMap, logEl, progressEl, labelIndex, labelTotal) {
    const queryTerm = letter + '*';
    let start = 0, numFound = null, gotThisLetter = 0, addedThisLetter = 0;

    while (true) {
        if (jnwCrawlCancelled) break;
        progressEl.textContent =
            (labelIndex != null ? `Letter ${labelIndex}/${labelTotal} ` : '') +
            `"${queryTerm}" — start=${start}${numFound !== null ? ` of ${numFound}` : ''} — ` +
            `${seenMap.size.toLocaleString()} unique entries so far`;

        let raw;
        try {
            // Cache-bust: several free CORS proxies cache responses, sometimes
            // loosely enough that different `start` values can come back
            // identical. Appending a unique, harmless param forces a fresh
            // request each time without affecting how JNW's own API parses it.
            const bustedUrl = jnwApiUrl(queryTerm, start, JNW_CRAWL_ROWS) + `&_cb=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            raw = await fetchWithCorsFallback(bustedUrl);
        } catch (err) {
            logEl.textContent += `⚠ "${queryTerm}" @ start=${start}: ${err.message}\n`;
            logEl.scrollTop = logEl.scrollHeight;
            break; // give up on this letter, move to the next one
        }

        let parsed;
        try {
            parsed = parseJNWApiResponse(raw);
        } catch (e) {
            parsed = null;
        }
        if (!parsed) {
            logEl.textContent += `⚠ "${queryTerm}" @ start=${start}: couldn't parse response\n`;
            logEl.scrollTop = logEl.scrollHeight;
            break;
        }

        // Diagnostic fingerprint: first and last returned term, plus which
        // proxy channel served this page. If these repeat identically across
        // different `start` values, the requests are being served from a cache
        // (proxy-side) rather than genuinely re-querying JNW.
        const firstTerm = parsed.entries[0]?.term || '(none)';
        const lastTerm = parsed.entries[parsed.entries.length - 1]?.term || '(none)';
        logEl.textContent += `  (via ${fetchWithCorsFallback.lastVia || '?'}) start=${start}: first="${firstTerm}" last="${lastTerm}"\n`;
        logEl.scrollTop = logEl.scrollHeight;

        numFound = parsed.numFound;
        let addedThisPage = 0;
        for (const e of parsed.entries) {
            // Include toevoeg (the field that seems to carry homograph/sense
            // distinctions) so two different entries that happen to share the
            // same headword + translation don't collapse into one.
            const key = e.href || `${e.term}|${e.toevoeg}|${e.translation}`;
            if (!seenMap.has(key)) {
                seenMap.set(key, e);
                addedThisPage++;
            }
        }
        gotThisLetter += parsed.entries.length;
        addedThisLetter += addedThisPage;

        // If a page returns far fewer *new* entries than it returned *raw*
        // results, that page was mostly re-serving documents we already have —
        // a sign of unstable pagination on the server side rather than a
        // dedup problem here. Surface it instead of hiding it.
        if (parsed.entries.length > 0 && addedThisPage < parsed.entries.length * 0.5) {
            logEl.textContent += `  ↳ note: page at start=${start} returned ${parsed.entries.length} results but only ${addedThisPage} were new (possible unstable pagination)\n`;
            logEl.scrollTop = logEl.scrollHeight;
        }

        // Advance by however many entries the server actually returned, not by
        // the rows we requested — the server appears to cap the real page size
        // well below what we ask for, and stepping by the requested amount
        // silently skips everything in between.
        const pageSize = parsed.entries.length;
        const reachedEnd = pageSize === 0 || gotThisLetter >= numFound;
        if (reachedEnd) break;
        start += pageSize;
        await new Promise(r => setTimeout(r, JNW_CRAWL_DELAY_MS));
    }

    logEl.textContent += `"${queryTerm}": ${gotThisLetter.toLocaleString()} raw results, ${addedThisLetter.toLocaleString()} new unique (numFound=${numFound ?? '?'})\n`;
    logEl.scrollTop = logEl.scrollHeight;

    return {gotThisLetter, addedThisLetter, numFound};
}

async function startJNWBackup() {
    if (jnwCrawlRunning) return;
    jnwCrawlRunning = true;
    jnwCrawlCancelled = false;

    const progressEl = document.getElementById('jnw-backup-progress');
    const logEl = document.getElementById('jnw-backup-log');
    const startBtn = document.getElementById('jnw-backup-start');
    const cancelBtn = document.getElementById('jnw-backup-cancel');
    const downloadBtn = document.getElementById('jnw-backup-download');
    const singleBtn = document.getElementById('jnw-single-letter-btn');

    logEl.textContent = '';
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    downloadBtn.disabled = true;
    singleBtn.disabled = true;

    const seen = new Map(); // dedupe key -> entry

    for (let i = 0; i < JNW_CRAWL_LETTERS.length; i++) {
        if (jnwCrawlCancelled) break;
        const letter = JNW_CRAWL_LETTERS[i];

        await crawlOneLetterIntoMap(letter, seen, logEl, progressEl, i + 1, JNW_CRAWL_LETTERS.length);

        const isLastLetter = i === JNW_CRAWL_LETTERS.length - 1;
        if (jnwCrawlCancelled || isLastLetter) continue;

        progressEl.textContent =
            `Paused after "${letter}*" (${i + 1}/${JNW_CRAWL_LETTERS.length}) — ` +
            `${seen.size.toLocaleString()} unique entries so far. Continue to "${JNW_CRAWL_LETTERS[i + 1]}*"?`;
        const shouldContinue = await waitForUserToContinue();
        document.getElementById('jnw-backup-pause-btns').style.display = 'none';
        if (!shouldContinue) break;
    }

    document.getElementById('jnw-backup-pause-btns').style.display = 'none';
    window._jnwBackupEntries = Array.from(seen.values());
    progressEl.textContent = jnwCrawlCancelled
        ? `Cancelled — ${seen.size.toLocaleString()} unique entries collected so far.`
        : `Done — ${seen.size.toLocaleString()} unique entries collected.`;

    if (window._jnwBackupEntries.length) {
        jnwBackupMeta = {
            source_name: 'jiddischwoordenboek.nl (JNW)',
            crawled_date: new Date().toISOString().slice(0, 10),
            entry_count: window._jnwBackupEntries.length
        };
        await saveJNWBackupToDB(jnwBackupMeta, window._jnwBackupEntries);
    }
    updateJNWOfflineUI();

    startBtn.disabled = false;
    cancelBtn.disabled = true;
    singleBtn.disabled = false;
    jnwCrawlRunning = false;
}

// Crawls just one letter/diacritic (for testing, or to top up an existing
// backup incrementally). Merges into whatever backup is already loaded
// rather than starting over, unlike the full multi-letter crawl above.
async function startJNWSingleLetterCrawl() {
    if (jnwCrawlRunning) return;
    const letter = document.getElementById('jnw-single-letter-select').value;
    if (!letter) return;

    jnwCrawlRunning = true;
    jnwCrawlCancelled = false;

    const progressEl = document.getElementById('jnw-backup-progress');
    const logEl = document.getElementById('jnw-backup-log');
    const startBtn = document.getElementById('jnw-backup-start');
    const cancelBtn = document.getElementById('jnw-backup-cancel');
    const singleBtn = document.getElementById('jnw-single-letter-btn');

    startBtn.disabled = true;
    cancelBtn.disabled = false;
    singleBtn.disabled = true;

    logEl.textContent += `— Testing "${letter}*" only —\n`;
    logEl.scrollTop = logEl.scrollHeight;

    // Seed the dedupe map from whatever backup already exists, so this adds
    // to it rather than replacing it.
    const seen = new Map();
    for (const e of (window._jnwBackupEntries || [])) {
        const key = e.href || `${e.term}|${e.toevoeg}|${e.translation}`;
        seen.set(key, e);
    }
    const before = seen.size;

    await crawlOneLetterIntoMap(letter, seen, logEl, progressEl, null, null);

    window._jnwBackupEntries = Array.from(seen.values());
    jnwBackupMeta = {
        source_name: jnwBackupMeta?.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: new Date().toISOString().slice(0, 10),
        entry_count: window._jnwBackupEntries.length
    };
    await saveJNWBackupToDB(jnwBackupMeta, window._jnwBackupEntries);
    updateJNWOfflineUI();

    progressEl.textContent = jnwCrawlCancelled
        ? `Stopped — added ${(seen.size - before).toLocaleString()} new entries so far (${seen.size.toLocaleString()} total in backup).`
        : `Done testing "${letter}*" — added ${(seen.size - before).toLocaleString()} new entries (${seen.size.toLocaleString()} total in backup).`;

    startBtn.disabled = false;
    cancelBtn.disabled = true;
    singleBtn.disabled = false;
    jnwCrawlRunning = false;
}

function downloadJNWBackup() {
    const entries = window._jnwBackupEntries || [];
    if (!entries.length) return;
    const dateStr = jnwBackupMeta?.crawled_date || new Date().toISOString().slice(0, 10);
    const payload = {
        source_name: jnwBackupMeta?.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: dateStr,
        entry_count: entries.length,
        entries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jnw_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function downloadYCDBackup() {
    const entries = appData.entries || [];
    if (!entries.length) return;
    const dateStr = appData.download_date || new Date().toISOString().slice(0, 10);
    const payload = {
        source_name: appData.source_name || 'yiddishculturaldictionary.org (YCD)',
        download_date: dateStr,
        entry_count: entries.length,
        entries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ycd_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── Status bar ────────────────────────────────────────────────────────────────
function refreshStatus() {
    const el = document.getElementById('ycd-status');
    const n = appData.entries.length;
    const name = appData.source_name || '--';
    const dl = appData.download_date;
    if (n) {
        el.textContent = `Loaded: ${name}  |  ${n.toLocaleString()} entries` +
            (dl ? `  |  Downloaded: ${dl}` : '');
    } else {
        el.textContent = 'No dictionary loaded.';
    }
    document.getElementById('ycd-backup-download').disabled = !n;
}

// ── File import ───────────────────────────────────────────────────────────────
function importFile() {
    document.getElementById('file-input').click();
}

function handleFile(input) {
    const file = input.files[0];
    if (!file) return;
    closeSettings();
    const reader = new FileReader();
    reader.onload = e => {
        finishImport(e.target.result, file.name, '');
    };
    reader.readAsText(file, 'utf-8');
    input.value = '';
}

async function finishImport(html, sourceName, downloadDate) {
    const entries = parseHTML(html);
    if (!entries.length) {
        alert('No entries found. Make sure the file has a <main> tag and entries separated by blank paragraphs.');
        return;
    }
    // Explicitly free old data from memory and storage before loading new data,
    // so we don't briefly hold both old and new entries in memory at once.
    appData = {source_name: null, download_date: '', entries: []};
    currentMatches = [];
    findMatches = [];
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
    }

    // Now load the new data
    appData = {source_name: sourceName, download_date: downloadDate, entries};
    await saveData();
    refreshStatus();
    document.getElementById('results-ycd').innerHTML = '<p class="message">Dictionary loaded. Type a word and tap Search.</p>';
    document.getElementById('count-ycd').textContent = '';
    alert(`Imported ${entries.length.toLocaleString()} entries from ${sourceName}`);
}

// ── Web import ────────────────────────────────────────────────────────────────

async function startWebImport() {
    const url = document.getElementById('url-input').value.trim();
    if (!url) return;
    const progress = document.getElementById('modal-progress');
    progress.innerHTML = '<span class="spinner"></span> Downloading…';

    try {
        // Use a CORS proxy since the iPhone can't do cross-origin requests directly
        // Try direct fetch first; fall back to proxy.
        let html;
        try {
            const resp = await fetch(url, {headers: {'Accept': 'text/html'}});
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            html = await resp.text();
        } catch (corsErr) {
            // Try allorigins CORS proxy
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
            const resp2 = await fetch(proxyUrl);
            if (!resp2.ok) throw new Error(`Proxy HTTP ${resp2.status}`);
            const data2 = await resp2.json();
            html = data2.contents;
        }

        const today = new Date().toISOString().slice(0, 10);
        closeSettings();
        finishImport(html, url, today);

        // Also offer to save as file on supported browsers
        if (window.showSaveFilePicker) {
            try {
                const fh = await window.showSaveFilePicker({
                    suggestedName: `downloaded_dictionary_${today}.html`,
                    types: [{description: 'HTML file', accept: {'text/html': ['.html']}}],
                });
                const writable = await fh.createWritable();
                await writable.write(html);
                await writable.close();
            } catch (e) { /* user cancelled save dialog -- fine */
            }
        }
    } catch (err) {
        progress.textContent = `Error: ${err.message}`;
    }
}

// ── Clear ─────────────────────────────────────────────────────────────────────
async function clearDictionary() {
    if (!appData.entries.length) {
        alert('No dictionary is currently loaded.');
        return;
    }
    if (!confirm('Remove the stored dictionary so you can import a new one?')) return;

    // Clear all in-memory references so the JS engine can garbage-collect
    // the entry objects immediately.
    appData = {source_name: null, download_date: '', entries: []};
    currentMatches = [];
    findMatches = [];

    // Await the async save so IndexedDB is fully cleared before we return.
    // We also explicitly clear the IndexedDB store (not just overwrite with
    // empty arrays) to ensure the storage is fully released.
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        // Fallback: write empty data
        await saveData();
    }
    // Also clear localStorage fallback
    try {
        localStorage.removeItem('dict_backup');
    } catch (_) {
    }

    refreshStatus();
    document.getElementById('results-ycd').innerHTML = '<p class="message">Dictionary cleared.</p>';
    document.getElementById('count-ycd').textContent = '';
    document.getElementById('search-input').value = '';
}

// ── Find in results ───────────────────────────────────────────────────────────
function toggleFind() {
    const bar = document.getElementById('findbar');
    if (bar.classList.contains('open')) {
        closeFind();
    } else {
        bar.classList.add('open');
        document.getElementById('find-input').focus();
    }
}

function closeFind(silent) {
    document.getElementById('findbar').classList.remove('open');
    document.getElementById('find-input').value = '';
    document.getElementById('find-count').textContent = '';
    clearFindHighlights();
    findMatches = [];
    findIndex = -1;
}

function findReset() {
    clearFindHighlights();
    findMatches = [];
    findIndex = -1;
    document.getElementById('find-count').textContent = '';
    const q = document.getElementById('find-input').value.trim();
    if (!q) return;
    buildFindMatches(q);
    if (findMatches.length) {
        findIndex = 0;
        scrollToFind();
    }
    updateFindCount();
}

function findNext() {
    if (!findMatches.length) {
        findReset();
        return;
    }
    findIndex = (findIndex + 1) % findMatches.length;
    scrollToFind();
    updateFindCount();
}

function findPrev() {
    if (!findMatches.length) {
        findReset();
        return;
    }
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    scrollToFind();
    updateFindCount();
}

function updateFindCount() {
    const el = document.getElementById('find-count');
    el.textContent = findMatches.length
        ? `${findIndex + 1} of ${findMatches.length}`
        : 'No matches';
}

// Find works by wrapping text nodes in <span class="find-hl"> elements
function buildFindMatches(query) {
    const container = document.getElementById('results-columns');
    const q = query.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const el = n.parentElement;
            if (!el || el.closest('#result-tabs')) return NodeFilter.FILTER_REJECT;
            const col = el.closest('.result-col');
            return col && col.offsetParent === null ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
    });
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
        const text = node.textContent;
        const lower = text.toLowerCase();
        let pos = 0;
        while (true) {
            const idx = lower.indexOf(q, pos);
            if (idx === -1) break;
            hits.push({node, start: idx, end: idx + q.length});
            pos = idx + q.length;
        }
    }

    // Wrap hits in spans (process in reverse to preserve offsets)
    const spans = [];
    for (let i = hits.length - 1; i >= 0; i--) {
        const {node, start, end} = hits[i];
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const span = document.createElement('span');
        span.className = 'find-hl';
        span.style.background = '#FFE082';
        span.style.borderRadius = '2px';
        range.surroundContents(span);
        spans.unshift(span);
    }
    findMatches = spans;
}

function clearFindHighlights() {
    document.querySelectorAll('.find-hl').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    // Merge adjacent text nodes
    document.getElementById('results-columns').normalize();
}

function scrollToFind() {
    document.querySelectorAll('.find-hl').forEach((s, i) => {
        s.style.background = i === findIndex ? '#FF9800' : '#FFE082';
    });
    if (findMatches[findIndex]) {
        findMatches[findIndex].scrollIntoView({behavior: 'smooth', block: 'center'});
    }
}

// ── Enter key on search ───────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
});

// ── Yiddish typing mode (Yiddish Klal layout) ─────────────────────────────────
// Maps physical keys (event.code) to the Yiddish Klal Mac layout:
// [plain, shift, option, shift+option]. Keys not listed here type normally.
const YK_MAP = {
    KeyA: ['אַ', 'א'],
    KeyS: ['ס', 'ת'],
    KeyD: ['ד', 'דזש'],
    KeyF: ['פֿ', 'ף'],
    KeyG: ['ג', 'דזש'],
    KeyH: ['ה', 'ח'],
    KeyJ: ['ײ', 'דזש'],
    KeyK: ['ק', 'כּ'],
    KeyL: ['ל', 'ל'],
    KeyQ: ['ק', 'כּ'],
    KeyW: ['ש', 'שׂ'],
    KeyE: ['ע', 'ײ'],
    KeyR: ['ר', 'טש'],
    KeyT: ['ט', 'תּ', 'תֿ'],
    KeyY: ['ײַ', 'ױ'],
    KeyU: ['ו', 'וּ'],
    KeyI: ['י', 'יִ'],
    KeyO: ['אָ', 'ױ'],
    KeyP: ['פּ', 'פ'],
    KeyZ: ['ז', 'זש'],
    KeyX: ['כ', 'ך', 'כֿ'],
    KeyC: ['צ', 'ץ'],
    KeyV: ['װ', 'בֿ'],
    KeyB: ['ב', 'בּ'],
    KeyN: ['נ', 'ן'],
    KeyM: ['מ', 'ם'],
    Minus: ['־', '-', '–', '—'],
    Equal: ['=', '+', '⸗'],
    BracketLeft: ['[', '„', '{', '’'],
    BracketRight: [']', '“', '}', '”'],
    Backslash: ['\\', '|', '׳', '״'],
    Quote: ["'", '"', '′', '″'],
    Semicolon: [';', ':', '…']
};

let yiddishOn = false;
try {
    yiddishOn = localStorage.getItem('yiddishTyping') === '1';
} catch (e) {
}
let yidLastWasTilde = false;

function updateYiddishUI() {
    const btn = document.getElementById('yid-toggle');
    btn.textContent = yiddishOn ? 'א' : 'A';
    btn.classList.toggle('on', yiddishOn);
    btn.setAttribute('aria-pressed', yiddishOn ? 'true' : 'false');
    ['search-input', 'find-input'].forEach(id =>
        document.getElementById(id).classList.toggle('yid-on', yiddishOn));
}

function setYiddish(on) {
    yiddishOn = on;
    try {
        localStorage.setItem('yiddishTyping', on ? '1' : '0');
    } catch (e) {
    }
    updateYiddishUI();
}

function insertAtCursor(el, text) {
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, text);
    } catch (e) {
    }
    if (!ok) {
        const start = el.selectionStart == null ? el.value.length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        el.setRangeText(text, start, end, 'end');
        el.dispatchEvent(new Event('input', {bubbles: true}));
    }
}

function yiddishKeydown(e) {
    if (e.isComposing || e.ctrlKey || e.metaKey) return;

    // "~" toggles the mode; "~~" types a literal "~" and leaves the mode unchanged.
    if (e.key === '~') {
        e.preventDefault();
        if (e.repeat) return;
        if (yidLastWasTilde) {
            yidLastWasTilde = false;
            setYiddish(!yiddishOn);
            insertAtCursor(e.target, '~');
        } else {
            yidLastWasTilde = true;
            setYiddish(!yiddishOn);
        }
        return;
    }

    if (['Shift', 'Alt', 'Control', 'Meta', 'CapsLock'].includes(e.key)) return;
    yidLastWasTilde = false;

    // Caps Lock types plain Latin, as in the Mac layout.
    if (!yiddishOn || e.getModifierState('CapsLock')) return;

    const m = YK_MAP[e.code];
    if (!m) return;
    const out = e.altKey ? (e.shiftKey ? m[3] : m[2]) : (e.shiftKey ? m[1] : m[0]);
    if (!out) return;
    e.preventDefault();
    insertAtCursor(e.target, out);
}

['search-input', 'find-input'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', yiddishKeydown));

const yidBtn = document.getElementById('yid-toggle');
yidBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the box
yidBtn.addEventListener('click', () => {
    setYiddish(!yiddishOn);
    document.getElementById('search-input').focus();
});
updateYiddishUI();

// ── Init ──────────────────────────────────────────────────────────────────────
// Restore the last-used dictionary scope (if any) and show/hide columns
// accordingly, without triggering a search on load.
(() => {
    loadDictState();
    refreshDictUI();
    setupTabCounts();
    checkCeyd();            // shows EYD only if the private relay answers
})();

// loadData is now async (IndexedDB), so we await it before refreshing the UI.
(async () => {
    const loaded = await loadData();
    refreshStatus();
    if (appData.entries.length) {
        document.getElementById('count-ycd').textContent =
            `${appData.entries.length.toLocaleString()} entries loaded`;
    }
    if (!loaded) {
        document.getElementById('results-ycd').innerHTML =
            '<p class="message">Type a word and tap Search.</p>';
    }
    document.getElementById('results-jnw').innerHTML =
        '<p class="message">Type a word and tap Search.</p>';

    // Restore a previously saved JNW local backup (if any) and the user's
    // last offline-mode preference, so both persist across app launches.
    const jnwBackup = await loadJNWBackupFromDB();
    if (jnwBackup) {
        jnwBackupMeta = jnwBackup.meta;
        window._jnwBackupEntries = jnwBackup.entries;
    }
    try {
        jnwOfflineMode = localStorage.getItem('jnwOfflineMode') === '1';
    } catch (e) {
    }
    updateJNWOfflineUI();

    // Populate the single-letter test/crawl dropdown.
    const singleSelect = document.getElementById('jnw-single-letter-select');
    singleSelect.innerHTML = JNW_CRAWL_LETTERS
        .map(l => `<option value="${l}">${l}*</option>`)
        .join('');
})();