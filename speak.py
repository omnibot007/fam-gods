"""speak.py - fam-gods voice leg: Kokoro bm_george (British male) reads aloud.
Usage: python speak.py "text to speak" | echo text | python speak.py
Flags: --voice NAME (default bm_george), --no-play (write wav only),
       --out PATH (default temp wav). Long inputs are chunked by sentence.
Text is lightly cleaned (code fences, URLs, markdown, emoji stripped) so
George speaks words, not syntax.
"""
import os
import re
import sys
import tempfile
import winsound

VOICE = os.environ.get("FAM_VOICE", "bm_lewis")


def clean(text):
    text = re.sub(r"```.*?```", " code block omitted. ", text, flags=re.S)
    text = re.sub(r"https?://\S+", " link omitted. ", text)
    text = re.sub(r"[#*_`>|~]", "", text)
    text = re.sub(r"[\U00010000-\U0010ffff]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def chunks(text, limit=600):
    parts, cur = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text):
        if len(cur) + len(sent) > limit and cur:
            parts.append(cur)
            cur = ""
        cur = (cur + " " + sent).strip()
    if cur:
        parts.append(cur)
    return parts or [text]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not sys.stdin.isatty():
        args = [sys.stdin.read()] + args
    text = clean(" ".join(args))
    if not text:
        print("speak: nothing to say", file=sys.stderr)
        return 2
    no_play = "--no-play" in sys.argv
    voice = VOICE
    for a in sys.argv[1:]:
        if a.startswith("--voice="):
            voice = a.split("=", 1)[1]
    from kokoro import KPipeline
    import soundfile as sf

    pipe = KPipeline(lang_code="b")
    wavs = []
    for i, part in enumerate(chunks(text)):
        for _, _, audio in pipe(part, voice=voice):
            path = os.path.join(tempfile.gettempdir(), f"fam-speak-{i}.wav")
            sf.write(path, audio, 24000)
            wavs.append(path)
            break
    if no_play:
        print("\n".join(wavs))
        return 0
    for w in wavs:
        winsound.PlaySound(w, winsound.SND_FILENAME)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
