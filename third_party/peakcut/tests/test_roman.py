"""Hindi and Urdu captions come out in Roman letters (Hinglish): the same words at the same moments, never
translated. The AI is replaced by a stand-in, so nothing leaves this machine."""
import os, sys, tempfile
os.environ["PEAKCUT_DATA"] = tempfile.mkdtemp(prefix="pc-roman-"); os.environ["DATABASE_URL"] = ""
sys.path.insert(0, ".")
from studio import brain, roman
fails = []
def check(n, ok, x=""):
    print(("PASS " if ok else "FAIL ") + n + (f"  {x}" if x and not ok else "")); ok or fails.append(n)
def ws(text):
    return [{"w": w, "s": i * 0.5, "e": i * 0.5 + 0.4} for i, w in enumerate(text.split())]
def text(words):
    return " ".join(w["w"] for w in words)

# ---- the spelling rules on their own
for hi, want in [("चूना जो उसको", "chuna jo usko"), ("कहना करता समझना", "kahna karta samajhna"), ("आज", "aaj"),
                 ("ज़िंदगी", "zindagi"), ("नहीं यार", "nahi yaar"), ("बात", "baat"), ("हमारा", "hamara"),
                 ("GTA गेम में 1000", "GTA gem mein 1000")]:
    check(f"{hi} -> {want}", roman.to_roman(hi) == want, roman.to_roman(hi))
check("English is left alone", roman.to_roman("Hello there, 25 cars!") == "Hello there, 25 cars!")

# ---- with no AI: every Hindi word is spelled out, at the same moment
def no_ai(*a, **k):
    raise RuntimeError("The AI is not set up on this server.")
brain.ask_ai = no_ai
src = ws("अरे चूना जो उसको लगा")
out = brain.fix_caption_words(src, "test")
check("without AI, Hindi captions come out in Roman letters", text(out) == "are chuna jo usko laga", text(out))
check("...with every word at its own time", [(w["s"], w["e"]) for w in out] == [(w["s"], w["e"]) for w in src])
check("short clips are spelled out too", text(brain.fix_caption_words(ws("जो उसको"), "")) == "jo usko")
out = text(brain.fix_caption_words(ws("یار یہ کیا ہے بھائی"), ""))
check("without AI, Urdu captions come out in Roman letters too", out == "yaar ye kya hai bhai", out)
check("Urdu punctuation and digits become plain ones", roman.to_roman("ہاں، ۱۰۰۰ روپے؟") == "haan, 1000 rupay?", roman.to_roman("ہاں، ۱۰۰۰ روپے؟"))

# ---- with the AI: its Hinglish is used, a translation is not, Urdu and other languages are handled
answers = {}
def fake_ai(prompt, schema=None, purpose=""):
    return answers["now"], "m", 10
brain.ask_ai = fake_ai
answers["now"] = ["Arre", "choona", "jo", "usko", "laga."]
check("the AI's Hinglish spelling is used", text(brain.fix_caption_words(src, "")) == "Arre choona jo usko laga.")
answers["now"] = ["Hey", "lime", "that", "him", "hit"]
out = text(brain.fix_caption_words(src, ""))
check("a translation is refused: the word is spelled out instead", out == "are chuna jo usko laga", out)
answers["now"] = ["Arre", "चूना", "jo", "usko", "laga"]
check("Hindi the AI left in its script is still spelled out", text(brain.fix_caption_words(src, "")) == "Arre chuna jo usko laga")
urdu = ws("یار یہ کیا ہے")
answers["now"] = ["Yaar", "ye", "kya", "hai"]
check("Urdu script becomes the AI's Roman spelling", text(brain.fix_caption_words(urdu, "")) == "Yaar ye kya hai")
spanish = ws("hola amigo que pasa")
answers["now"] = ["Hola", "amigo,", "¿qué", "pasa?"]
check("Spanish stays Spanish", text(brain.fix_caption_words(spanish, "")) == "Hola amigo, ¿qué pasa?")
answers["now"] = ["one", "two"]
check("an answer of the wrong length keeps the words, in Roman letters", text(brain.fix_caption_words(src, "")) == "are chuna jo usko laga")

# ---- what the AI writes for the screen
c = brain._tidy({"hook": "चूना लगा", "title": "उसको चूना", "highlight_words": ["चूना", "boss"], "score": 90}, 1, 20)
check("hook, title and highlighted words are in Roman letters", (c["hook"], c["title"], c["highlight_words"]) == ("CHUNA LAGA", "usko chuna", ["chuna", "boss"]), str(c))

# ---- the language rule: English stays, Hindi/Urdu in Roman letters, everything else translated into English
check("which languages are translated", [brain.needs_translation(x) for x in ("en", "en-US", "hi", "ur", "es", "ar", "")]
      == [False, False, False, False, True, True, False])
def by_purpose(prompt, schema=None, purpose=""):
    if purpose == "Caption translation":
        n = int(prompt.split("Lines (")[1].split(")")[0])
        return [f"English line {i + 1}" for i in range(n)], "m", 10
    return answers["now"], "m", 10
brain.ask_ai = by_purpose
es = [{"w": w, "s": s, "e": s + 0.4} for w, s in (("hola", 0.0), ("amigo", 0.5), ("que", 1.0), ("pasa", 1.5), ("hoy.", 2.0),
                                                     ("vamos", 5.0), ("a", 5.5), ("ganar", 6.0), ("esto", 6.5))]
yt_en = [{"w": w, "s": i * 0.5, "e": i * 0.5 + 0.4} for i, w in enumerate("hi friend what is up today".split())]
answers["now"] = ["Hi", "friend,", "what", "is", "up", "today?"]
out = brain.english_captions(es, "es", "", youtube_english=lambda: yt_en)
check("Spanish with YouTube's English captions: those are used, tidied by the AI", text(out) == "Hi friend, what is up today?", text(out))
out = brain.english_captions(es, "es", "", youtube_english=lambda: None)
check("Spanish with no English from YouTube: the AI translates it", text(out) == "English line 1 English line 2", text(out))
check("...each English line on the moment its line was said", out[0]["s"] == 0.0 and out[-1]["s"] >= 5.0 and out[-1]["e"] <= 6.95, str(out))
brain.ask_ai = no_ai
ar = ws("مرحبا يا صديقي كيف حالك")
out = brain.english_captions(ar, "ar", "", youtube_english=lambda: None)
check("Arabic with neither: still in English letters", not any(roman.needs_roman(w["w"]) for w in out) and len(out) == 5, text(out))
out = brain.english_captions(ws("जो उसको"), "hi", "")
check("Hindi is never translated, only spelled in Roman letters", text(out) == "jo usko", text(out))
brain.ask_ai = by_purpose
answers["now"] = ["Hello", "there", "friend."]
check("English stays English", text(brain.english_captions(ws("hello there friend"), "en", "")) == "Hello there friend.")

print("ALL PASSED" if not fails else f"{len(fails)} failed")
import shutil; shutil.rmtree(os.environ["PEAKCUT_DATA"], ignore_errors=True)
sys.exit(1 if fails else 0)
