# Rebuilds supabase/functions/mailer/fonts.ts (fonts for the voucher PDF).
# Needs: pip install fonttools brotli; Liberation fonts (apt install fonts-liberation).
# Run from the repo root: python3 scripts/pdf-fonts.py
import base64, io
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import merge, subset

R = 'public/fonts/'

def ttf(files, wght=None):
    parts = []
    for f in files:
        t = TTFont(R + f); t.flavor = None
        if 'fvar' in t:
            axes = {a.axisTag: a.defaultValue for a in t['fvar'].axes}  # pin every axis (merge needs static fonts)
            axes['wght'] = wght or 400
            t = instancer.instantiateVariableFont(t, axes)
        b = io.BytesIO(); t.save(b); b.seek(0); parts.append(b)
    if len(parts) == 1: return parts[0].getvalue()
    tmp = []
    for i, p in enumerate(parts):
        n = f'/tmp/_pdffont{i}.ttf'; open(n, 'wb').write(p.getvalue()); tmp.append(n)
    out = io.BytesIO(); merge.Merger().merge(tmp).save(out); return out.getvalue()

def fallback():
    opts = subset.Options(); f = TTFont('/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf')
    s = subset.Subsetter(opts)
    s.populate(unicodes=list(range(0x20, 0x7F)) + list(range(0xA0, 0x250)) + list(range(0x400, 0x460)) + list(range(0x2010, 0x2028)) + [0x20AC])
    s.subset(f); b = io.BytesIO(); f.save(b); return b.getvalue()

fonts = {
    'anton': ttf(['Anton-latin-a6f395.woff2']),
    'bodoni': ttf(['BodoniModa-latin-aad168.woff2', 'BodoniModa-latin-ext-f43160.woff2']),
    'bodoniItalic': ttf(['BodoniModa-latin-5d0b87.woff2', 'BodoniModa-latin-ext-212245.woff2']),
    'mono': ttf(['SpaceMono-latin-e04b1d.woff2', 'SpaceMono-latin-ext-3c18ea.woff2']),
    'serifFallback': fallback(),
}
out = ["// Fonts for the voucher PDF (base64 TTF). Bodoni Moda, Anton, Space Mono: the site's own fonts (SIL OFL).",
       '// Liberation Serif Italic (SIL OFL) is the fallback for Cyrillic text. Regenerate with scripts/pdf-fonts.py.',
       'const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));', 'export const fonts = {']
out += [f"  {k}: b64('{base64.b64encode(v).decode()}')," for k, v in fonts.items()]
out.append('};')
open('supabase/functions/mailer/fonts.ts', 'w').write('\n'.join(out) + '\n')
