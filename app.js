'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let appData = {source_name: null, download_date: '', entries: []};
let currentMatches = [];   // entries from last search
let findMatches = [];    // DOM text nodes + offsets for find-in-page
let findIndex = -1;

// ── Persistence via IndexedDB ─────────────────────────────────────────────────
// IndexedDB is far more persistent than localStorage on iOS PWAs --
// Safari does not evict it the way it does localStorage.
const IDB_NAME = 'TypepadApp';
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
