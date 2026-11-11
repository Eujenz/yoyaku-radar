"""Subset the LINE Seed fonts to the characters the built site actually uses.

Usage: python3 scripts/subset_fonts.py <dist dir>
Writes dist/assets/fonts/*.woff2 and dist/assets/fonts.css. Needs: pip install fonttools brotli
LINE Seed TW covers Traditional Chinese, kana and Latin; LINE Seed JP fills in Japanese-only kanji.
"""
import hashlib
import html
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
DIST = Path(sys.argv[1])
OUT = DIST / "assets" / "fonts"
FACES = [  # (family, weight, file)
    ("LINE Seed TW", 400, "LINESeedTW_TTF_Rg.ttf"),
    ("LINE Seed TW", 700, "LINESeedTW_TTF_Bd.ttf"),
    ("LINE Seed JP", 400, "LINESeedJP_TTF_Rg.ttf"),
    ("LINE Seed JP", 700, "LINESeedJP_TTF_Bd.ttf"),
]

chars = set()
for path in list(DIST.rglob("*.html")) + [DIST / "assets" / "app.js"]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".html":
        text = re.sub(r"(?s)<script.*?</script>", " ", text)
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    chars.update(ord(c) for c in text if ord(c) >= 0x20)
chars.update(range(0x20, 0x7F))  # always keep basic Latin and digits (countdowns, prices)

OUT.mkdir(parents=True, exist_ok=True)
tw_cmap = set(TTFont(ROOT / "fonts" / FACES[0][2], lazy=True).getBestCmap())
css = []
total = 0
for family, weight, name in FACES:
    src = ROOT / "fonts" / name
    cmap = set(TTFont(src, lazy=True).getBestCmap())
    wanted = (chars & cmap) if family == "LINE Seed TW" else (chars & cmap) - tw_cmap
    if not wanted:
        continue
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["kern", "liga", "locl", "palt", "vert"]
    options.name_IDs = [0, 1, 2, 13, 14]  # keep copyright and licence notices
    options.notdef_outline = True
    options.drop_tables += ["meta", "DSIG"]
    font = subset.load_font(str(src), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(wanted))
    subsetter.subset(font)
    tmp = OUT / "tmp.woff2"
    subset.save_font(font, str(tmp), options)
    digest = hashlib.sha1(tmp.read_bytes()).hexdigest()[:10]
    final = OUT / f"{name.split('_')[0].lower()}-{weight}.{digest}.woff2"
    tmp.replace(final)
    total += final.stat().st_size
    css.append(
        f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};font-display:swap;'
        f'src:url("fonts/{final.name}") format("woff2")}}'
    )
    print(f"{final.name}: {len(wanted)} characters, {final.stat().st_size // 1024} KB")
(DIST / "assets" / "fonts.css").write_text("\n".join(css) + "\n", encoding="utf-8")
print(f"fonts: {total // 1024} KB total for {len(chars)} distinct characters")
