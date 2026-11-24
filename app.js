'use strict';

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

// ── Hebrew typing mode (MacOS Hebrew layout) ─────────────────────────────────
// Maps physical keys (event.code) to the MacOS Hebrew layout:
// [plain, shift, option, shift+option]. Keys not listed here type normally.
const HE_MAP = {
    KeyA: ['ש', 'שׁ', 'שׂ', 'שׂ'],
    KeyS: ['ד', '', '‎', ''],
    KeyD: ['ג', '„', '‏', ''],
    KeyF: ['כ', '', '€', '€'],
    KeyG: ['ע', '', '֞', ''],
    KeyH: ['י', '', 'ײַ', 'ײַ'],
    KeyJ: ['ח', '', '”', ''],
    KeyK: ['ל', 'לֹ', '֜', ''],
    KeyL: ['ך', '', '’', ''],
    KeyQ: ['/', '', '…', '…'],
    KeyW: ['׳', '', 'ָ', 'ָ'],
    KeyE: ['ק', '', '', ''],
    KeyR: ['ר', '', '', ''],
    KeyT: ['א', '', '', ''],
    KeyY: ['ט', '', '', ''],
    KeyU: ['ו', 'וֹ', 'וּ', 'וּ'],
    KeyI: ['ן', '', '', ''],
    KeyO: ['ם', '', '', ''],
    KeyP: ['פ', '', '', ''],
    KeyZ: ['ז', '', '–', '–'],
    KeyX: ['ס', '', '—', ''],
    KeyC: ['ב', 'לֹ', '“', ''],
    KeyV: ['ה', '', '”', '”'],
    KeyB: ['נ', '', '‘', '֜'],
    KeyN: ['מ', '', '’', ''],
    KeyM: ['צ', '', 'שׁ', 'שׁ'],
    Minus: ['-', '_', '-', '-'],
    Equal: ['=', '+', 'ֹ', 'ֹ'],
    BracketLeft: [']', '}', '', ''],
    BracketRight: ['[', '{', '', ''],
    Backslash: ['ֿ', '|', '־', ''],
    Quote: [",", '״', 'ֲ', 'ֲ'],
    Semicolon: ['ף', ':', ';', ';'],
    Digit0: ['0', '(', 'ְ', 'ְ'],
    Digit1: ['1', '!', 'ֲ', ''],
    Digit2: ['2', '@', 'ֳ', 'ֳ'],
    Digit3: ['3', '#', 'ֱ', 'ֱ'],
    Digit4: ['4', '$', 'ִ', 'ִ'],
    Digit5: ['5', '%', 'ֵ', 'ֵ'],
    Digit6: ['ף', ':', ';', ';'],
    Digit7: ['7', '₪', 'ָ', 'ָ'],
    Digit8: ['8', '*', 'ֻ', 'ֻ']ת
    Digit9: ['9', ')', 'ֶ', 'ֶ']
};

let yiddishOn = false;
/*try {
    yiddishOn = localStorage.getItem('yiddishTyping') === '1';
} catch (e) {
} */ // got rid of feature to read previous setting.  Want to default to as it is set in the website
let yidLastWasTilde = false;

function updateLangUI() {
    const btn = document.getElementById('lang-toggle');
    btn.textContent = yiddishOn ? 'Y' : 'H';
    btn.classList.toggle('on', yiddishOn);
    btn.setAttribute('aria-pressed', yiddishOn ? 'true' : 'false');
    ['search-input'].forEach(id =>
        document.getElementById(id).classList.toggle('yid-on', yiddishOn));
}

function setYiddish(on) {
    yiddishOn = on;
    try {
        localStorage.setItem('yiddishTyping', on ? '1' : '0');
    } catch (e) {
    }
    updateLangUI();
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

function langKeydown(e) {
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
    //if (!yiddishOn || e.getModifierState('CapsLock')) return;
    if (e.getModifierState('CapsLock')) return;

    if (yiddishOn) {
        const m = YK_MAP[e.code];
        if (!m) return;
        const out = e.altKey ? (e.shiftKey ? m[3] : m[2]) : (e.shiftKey ? m[1] : m[0]);
        if (!out) return;
        e.preventDefault();
        insertAtCursor(e.target, out);
    } else {
        const m = HE_MAP[e.code];
        if (!m) return;
        const out = e.altKey ? (e.shiftKey ? m[3] : m[2]) : (e.shiftKey ? m[1] : m[0]);
        if (!out) return;
        e.preventDefault();
        insertAtCursor(e.target, out);
    }
}

['search-input'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', langKeydown));

const yidBtn = document.getElementById('lang-toggle');
yidBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the box
yidBtn.addEventListener('click', () => {
    setYiddish(!yiddishOn);
    document.getElementById('search-input').focus();
});
updateLangUI();
