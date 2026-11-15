"""Hindi and Urdu in Roman letters ("Hinglish"), for captions: चूना जो उसको -> chuna jo usko, یار کیا ہے -> yaar kya hai.

Not a translation: the same word, spelled the way people type it in chats. The AI does this when it tidies a
clip's captions (brain.fix_caption_words); this is the fallback for when there is no AI, or it missed a word, so
that a caption is never drawn in Hindi or Urdu script. Urdu is written without most vowels, so common words come
from a list and the rest are spelled from their letters: readable, if not always how a person would type it."""
import re

_VOWELS = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai",
           "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e"}
_SIGNS = {"ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o",
          "ौ": "au", "ॉ": "o", "ॅ": "e"}
_CONS = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh",
         "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh",
         "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v",
         "श": "sh", "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
         "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "फ़": "f", "ड़": "r", "ढ़": "rh", "य़": "y"}
_NUKTA = {"क": "q", "ख": "kh", "ग": "gh", "ज": "z", "फ": "f", "ड": "r", "ढ": "rh", "य": "y"}
_VIRAMA, _NUKTA_SIGN = "्", "़"
_NASAL = {"ं": "n", "ँ": "n"}
_OTHER = {"ः": "h", "।": ".", "॥": ".", "ॐ": "om", **{chr(0x0966 + i): str(i) for i in range(10)}}
# Common words whose everyday spelling the rules below would not guess.
_WORDS = {"में": "mein", "मैं": "main", "हैं": "hain", "है": "hai", "नहीं": "nahi", "नही": "nahi", "हूँ": "hoon",
          "हूं": "hoon", "क्या": "kya", "क्यों": "kyun", "क्यूँ": "kyun", "यह": "yeh", "वह": "woh", "और": "aur",
          "भी": "bhi", "ही": "hi", "की": "ki", "जी": "ji", "तो": "to", "हाँ": "haan", "हां": "haan", "यहाँ": "yahan",
          "यहां": "yahan", "वहाँ": "wahan", "वहां": "wahan", "कहाँ": "kahan", "कहां": "kahan", "थी": "thi",
          "रही": "rahi", "कभी": "kabhi", "अभी": "abhi", "सभी": "sabhi", "भाई": "bhai", "मुझे": "mujhe",
          "तुम": "tum", "हम": "hum", "आप": "aap", "बहुत": "bahut", "अच्छा": "accha", "ठीक": "theek", "लिए": "liye"}
DEVANAGARI = re.compile(r"[ऀ-ॿ]")
OTHER_SCRIPT = re.compile(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")   # Urdu / Arabic letters


def has_hindi(text: str) -> bool:
    return bool(DEVANAGARI.search(text or ""))


def needs_roman(text: str) -> bool:
    """Is this Hindi or Urdu script, which captions should show in Roman letters?"""
    return bool(DEVANAGARI.search(text or "") or OTHER_SCRIPT.search(text or ""))


def _word(w: str) -> str:
    if w in _WORDS:
        return _WORDS[w]
    # One unit per letter: [roman consonant or vowel, its vowel or None (None = a consonant with no vowel), is_cons]
    units, i = [], 0
    while i < len(w):
        ch = w[i]
        nxt = w[i + 1] if i + 1 < len(w) else ""
        if ch in _CONS:
            c = _CONS[ch]
            if nxt == _NUKTA_SIGN:
                c = _NUKTA.get(ch, c)
                i += 1
                nxt = w[i + 1] if i + 1 < len(w) else ""
            if nxt == _VIRAMA:
                units.append([c, None, True, False])
                i += 2
                continue
            if nxt in _SIGNS:
                units.append([c, _SIGNS[nxt], True, False])
                i += 2
                continue
            units.append([c, "a", True, True])        # the vowel every Hindi letter carries unless told otherwise
        elif ch in _VOWELS:
            units.append(["", _VOWELS[ch], False, False])
        elif ch in _NASAL:
            if units:
                units[-1][1] = (units[-1][1] or "") + "n"
                units[-1][3] = False
                units[-1].append("nasal")
            else:
                units.append(["n", None, True, False])
        elif ch in _OTHER:
            units.append([_OTHER[ch], None, False, False])
        elif ch == _NUKTA_SIGN or ch == _VIRAMA:
            pass
        else:
            units.append([ch, None, False, False])
        i += 1
    letters = [u for u in units if u[2] or u[1]]
    # Hindi drops the carried "a" at the end of a word, and between a vowel and another vowel-carrying letter
    # (कहना -> kahna, not kahana). Looked at right to left, as speakers do.
    if len(letters) > 1 and letters[-1][3]:
        letters[-1][1] = None
    for k in range(len(letters) - 2, 0, -1):
        u, before, after = letters[k], letters[k - 1], letters[k + 1]
        if u[3] and before[1] and after[2] and after[1] and "nasal" not in before:
            u[1] = None
    # Long vowels the way people type them: doubled only before a consonant that ends a syllable (baat, kaam,
    # aaj), single elsewhere (hamara, pata, ki, tu).
    short = {"aa": "a", "ee": "i", "oo": "u"}
    for k, u in enumerate(letters):
        if u[1] in short:
            after = letters[k + 1] if k + 1 < len(letters) else None
            if after is None or after[1]:
                u[1] = short[u[1]]
    return "".join(u[0] + (u[1] or "") for u in units)


# ---------------------------------------------------------------- Urdu
_UR_WORDS = {"ہے": "hai", "ہیں": "hain", "ہوں": "hoon", "ہو": "ho", "ہی": "hi", "یہ": "ye", "وہ": "wo", "کیا": "kya",
             "کیوں": "kyun", "نہیں": "nahi", "نہ": "na", "میں": "main", "میرا": "mera", "میری": "meri", "میرے": "mere",
             "تو": "to", "کہ": "ke", "کی": "ki", "کا": "ka", "کے": "ke", "کو": "ko", "سے": "se", "پر": "par",
             "اور": "aur", "بھی": "bhi", "تھا": "tha", "تھی": "thi", "تھے": "the", "گیا": "gaya", "گئی": "gayi",
             "رہا": "raha", "رہی": "rahi", "رہے": "rahe", "بہت": "bahut", "اچھا": "achha", "یار": "yaar", "بھائی": "bhai",
             "آپ": "aap", "ہم": "hum", "تم": "tum", "مجھے": "mujhe", "تمہیں": "tumhein", "اب": "ab", "کر": "kar",
             "کرو": "karo", "کرنا": "karna", "دیکھو": "dekho", "چلو": "chalo", "ابھی": "abhi", "کبھی": "kabhi",
             "جی": "ji", "ہاں": "haan", "نا": "na", "اللہ": "Allah", "ٹھیک": "theek", "پتا": "pata", "پتہ": "pata",
             "لیکن": "lekin", "پھر": "phir", "سب": "sab", "کچھ": "kuch", "کون": "kaun", "کہاں": "kahan", "یہاں": "yahan",
             "وہاں": "wahan", "ایک": "ek", "دو": "do", "اپنا": "apna", "اپنی": "apni", "لوگ": "log", "بات": "baat",
             "کام": "kaam", "دن": "din", "آج": "aaj", "کل": "kal", "بس": "bas", "شکریہ": "shukriya", "واہ": "wah",
             "گھر": "ghar", "ہوا": "hua", "ہوئی": "hui", "ہوئے": "hue", "اس": "us", "ان": "un", "جو": "jo", "جب": "jab",
             "تب": "tab", "مگر": "magar", "پاکستان": "Pakistan", "زندگی": "zindagi", "پیسے": "paise", "روپے": "rupay"}
_UR_CONS = {"ب": "b", "پ": "p", "ت": "t", "ٹ": "t", "ث": "s", "ج": "j", "چ": "ch", "ح": "h", "خ": "kh", "د": "d",
            "ڈ": "d", "ذ": "z", "ر": "r", "ڑ": "r", "ز": "z", "ژ": "zh", "س": "s", "ش": "sh", "ص": "s", "ض": "z",
            "ط": "t", "ظ": "z", "غ": "gh", "ف": "f", "ق": "q", "ک": "k", "ك": "k", "گ": "g", "ل": "l", "م": "m",
            "ن": "n", "ہ": "h", "ه": "h", "ة": "a", "ھ": "h"}
_UR_MARKS = {"َ": "a", "ِ": "i", "ُ": "u", "ّ": "", "ْ": "", "ً": "an", "ٰ": "a"}
_UR_DIGITS = {**{chr(0x06F0 + i): str(i) for i in range(10)}, **{chr(0x0660 + i): str(i) for i in range(10)}}


def _urdu_word(w: str) -> str:
    if w in _UR_WORDS:
        return _UR_WORDS[w]
    out, prev_cons = [], False
    for i, ch in enumerate(w):
        first, last = i == 0, i == len(w) - 1
        nxt = w[i + 1] if i + 1 < len(w) else ""
        if ch in _UR_MARKS:
            out.append(_UR_MARKS[ch])
            prev_cons = False
            continue
        if ch in _UR_DIGITS:
            out.append(_UR_DIGITS[ch])
            prev_cons = False
            continue
        if ch == "ھ":                     # do chashmi he: the "h" of bh, ph, kh, chh...
            out.append("h")
            continue
        if ch in "اآ":
            out.append("aa" if ch == "آ" else "a")
            prev_cons = False
            continue
        if ch in "وؤ":
            if first or not prev_cons:
                out.append("w" if nxt not in "اآ" else "w")
                prev_cons = True
            else:
                out.append("o")
                prev_cons = False
            continue
        if ch in "یيئى":
            if first:
                out.append("y")
                prev_cons = True
            else:
                out.append("i" if last else "ee" if prev_cons and nxt not in "اآوؤ" else "y")
                prev_cons = out[-1] == "y"
            continue
        if ch == "ے":
            out.append("e")
            prev_cons = False
            continue
        if ch in "ںن" and ch == "ں":
            out.append("n")
            continue
        if ch in "عء":
            continue
        c = _UR_CONS.get(ch)
        if c is None:
            out.append(ch)
            prev_cons = False
            continue
        if ch in "ہه" and last and prev_cons:
            out.append("a")               # a final ہ after a consonant is a vowel: کہ, بچہ -> bacha
            prev_cons = False
            continue
        if prev_cons and i == 1 or (prev_cons and i == 2 and w[1] == "ھ"):
            out.append("a")               # the short "a" Urdu does not write after a word's first letter: گھر -> ghar
        out.append(c)
        prev_cons = True
    s = "".join(out)
    if re.fullmatch(r"[a-z]{2,}", s) and not re.search(r"[aeiou]", s):
        s = s[:-1] + "a" + s[-1]          # no vowel at all: give it the one Urdu leaves out
    return s


_HINDI_RUN = r"[ऀ-ॿ]+"
_URDU_RUN = r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+"


def to_roman(text: str) -> str:
    """Every Hindi and Urdu word in the text spelled in Roman letters. Anything else is left exactly as it is."""
    text = text or ""
    if DEVANAGARI.search(text):
        text = re.sub(_HINDI_RUN, lambda m: _word(m.group(0)), text)
    if OTHER_SCRIPT.search(text):
        text = text.replace("،", ",").replace("؟", "?").replace("۔", ".")
        text = re.sub(_URDU_RUN, lambda m: _urdu_word(m.group(0)), text)
    return text


def words(ws: list) -> list:
    """Caption words ({'w', 's', 'e'}) with any Hindi or Urdu in Roman letters. Timings are untouched."""
    return [dict(w, w=to_roman(w["w"])) if needs_roman(w.get("w", "")) else w for w in ws]
