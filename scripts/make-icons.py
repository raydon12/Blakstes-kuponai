#!/usr/bin/env python3
"""Draws the salon's PNG icons and the social-preview picture from salon.config.json.

    python3 scripts/make-icons.py [path/to/salon.config.json]

Writes into public/: og.png (1200x630), icon-512.png, icon-192.png,
apple-touch-icon.png (180), favicon-32.png. Needs Pillow (pip install pillow).
Run it once per new salon and commit the PNGs. favicon.svg is filled in by build.js.
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'salon.config.json').read_text('utf8'))
PUB, FONTS = ROOT / 'public', ROOT / 'public' / 'fonts' / 'pdf'
INK, BONE, MIST = (17, 16, 16), (243, 238, 233), (185, 176, 170)
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
ACCENT = hexrgb(cfg['colors']['accent'])
name = cfg['brand']['name'].strip()
sub = (cfg['brand'].get('subtitle') or {}).get('lt', '')
vmin = cfg['vouchers']['min']
font = lambda f, s: ImageFont.truetype(str(FONTS / f), s)


def spaced(d, xy, text, f, fill, track):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + track
    return x


def spaced_w(d, text, f, track):
    return sum(d.textlength(c, font=f) for c in text) + track * max(0, len(text) - 1)


# social preview
W, H = 1200, 630
img = Image.new('RGB', (W, H), INK)
glow = Image.new('RGB', (W, H), INK)
ImageDraw.Draw(glow).ellipse((450, -150, 1150, 450), fill=tuple(int(a * .18 + b * .82) for a, b in zip(ACCENT, INK)))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(160)), 1)
d = ImageDraw.Draw(img)
size = 44
while size > 22 and spaced_w(d, name.upper(), font('bodoni.ttf', size), 4) > W - 180:
    size -= 2
spaced(d, (92, 150), name.upper(), font('bodoni.ttf', size), BONE, 4)
if sub:
    spaced(d, (94, 150 + size + 18), sub.upper(), font('spacemono.ttf', 15), MIST, 6)
# anton.ttf is a subset without Ų, so missing letters come from the web font (same typeface)
from fontTools.ttLib import TTFont
have = set(TTFont(str(FONTS / 'anton.ttf'))['cmap'].getBestCmap())
title, bs = 'DOVANŲ KUPONAI', 190
pickf = lambda ch, s: font('anton.ttf', s) if ord(ch) in have else ImageFont.truetype(str(ROOT / 'public/fonts/Anton-latin-ext-cfa139.woff2'), s)
while sum(d.textlength(c, font=pickf(c, bs)) for c in title) > W - 180:
    bs -= 4
x = 88
for c in title:
    f = pickf(c, bs)
    d.text((x, 440 - bs * 1.08), c, font=f, fill=BONE)
    x += d.textlength(c, font=f)
d.text((92, 500), f'nuo {vmin} € · su QR kodu', font=font('bodoni-italic.ttf', 44), fill=ACCENT)
img.save(PUB / 'og.png', optimize=True)

# square icons: dark tile with the first letter in the accent colour
letter = name[:1].upper()
for px, out in [(512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon.png'), (32, 'favicon-32.png')]:
    S = 512
    ic = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dd = ImageDraw.Draw(ic)
    dd.rounded_rectangle((0, 0, S - 1, S - 1), radius=0 if out != 'favicon-32.png' else 112, fill=INK)
    f = font('bodoni.ttf', 330)
    bb = dd.textbbox((0, 0), letter, font=f)
    dd.text(((S - (bb[2] - bb[0])) / 2 - bb[0], (S - (bb[3] - bb[1])) / 2 - bb[1]), letter, font=f, fill=ACCENT)
    ic.resize((px, px), Image.LANCZOS).save(PUB / out, optimize=True)

print('✓ og.png и иконки обновлены в public/')
