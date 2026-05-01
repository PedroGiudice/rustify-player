import json, os, base64, urllib.request

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL = "gemini-3.1-pro-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

with open("/home/opc/rustify-player/docs/ui-generation-system-prompt.md") as f:
    system_prompt = f.read()

user_prompt = """## Ultra-refinement pass — Band Detail Panel v3

I'm attaching the REAL app screenshot (Signal view) as ground truth.

### Task

Generate a complete standalone HTML prototype of the **Parametric Equalizer section** of the Signal view, including a NEW **band detail panel** that appears when a band is selected.

### Band detail panel spec

A horizontal strip between the fader row and the Mode selector, showing per-band controls for the active band:

```
Band 2 · 26 Hz · Bell                    Type [Bell ▼]   Mode [APO (DR) ▼]   Slope [x1 ▼]   Q: 2.21   [S] [M]
```

- Left: band number + frequency + current type as contextual label
- Right: three native `<select>` dropdowns + Q display + Solo/Mute toggles
- Background: `var(--surface-container)` to visually distinguish from the fader area
- Borders: `border-top: 1px solid var(--divider)` above, `border-bottom: 1px solid var(--divider)` below

### Select dropdown values

**Type**: Off, Bell, Hi-pass, Hi-shelf, Lo-pass, Lo-shelf, Notch, Resonance, Allpass, Bandpass, Ladder-pass, Ladder-rej
**Mode**: RLC (BT), RLC (MT), BWC (BT), BWC (MT), LRX (BT), LRX (MT), APO (DR)
**Slope**: x1, x2, x3, x4

### Solo/Mute buttons

- 26×26px toggle buttons with single letter (S / M)
- Inactive: `var(--on-surface-mute)` text, `var(--divider-hi)` border
- Solo active: `var(--sig-warn)` text+border, 10% amber background tint
- Mute active: `var(--sig-err)` text+border, 10% red background tint

### Critical visual requirements (match the screenshot EXACTLY)

1. **Canvas**: 170px height, dark background. Draw a mock frequency response curve using SVG: an orange polyline (`var(--primary)`, stroke-width 2) with small circles (r=4) at each band's frequency position. The curve should show slight dips at bands 1-4 (matching the -1.1, -1.7, -1.1, -2.2 dB values) and flat at 0dB for the rest.

2. **X-axis labels**: Between the canvas and faders, a row showing: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k — spread across the full width, logarithmic scale feel.

3. **Faders**: 
   - Track: 110px height, 2px wide, `var(--divider-hi)` color
   - Zero line: 8px wide × 2px tall mark at vertical center of each track, `var(--divider-hi)` color
   - Thumb: 12px diameter circle, `var(--on-surface-variant)` inactive, `var(--primary)` active
   - Gain fill: when gain != 0, a 2px wide bar from zero line to thumb, `var(--primary)` at 70% opacity
   - Freq label above: `var(--text-label-xs)`, `var(--on-surface-mute)`
   - Gain label below: `var(--text-label-xs)`, `var(--on-surface-mute)` for inactive, `var(--primary)` for active band only

4. **Mode selector**: Individual buttons, NO outer border on the group. Each button has its own border. Active button: `var(--primary)` background, `var(--on-primary)` text.

5. **Header**: "Parametric Equalizer" in `var(--font-body)`, bold. Right side: "LSP x16 Stereo" label + toggle pill.

6. **Overall card**: `var(--surface-container-low)` background, `1px solid var(--divider)` border, NO border-radius (sharp corners).

### Interactivity

- Clicking a fader selects it (orange thumb, orange gain label, updates band detail panel)
- Solo/Mute buttons toggle on click
- Type select updates the contextual label on the left
- Band 2 (26 Hz) starts as selected

### Output

Single complete HTML file with inlined CSS and JS. Google Fonts for Inter and Fraunces. This is the FINAL visual reference for integration into the real app."""

parts = []

# Attach real app screenshot
with open("/tmp/rustify-signal-screenshot.png", "rb") as img:
    parts.append({
        "inline_data": {"mime_type": "image/png", "data": base64.b64encode(img.read()).decode()}
    })

parts.append({"text": user_prompt})

payload = {
    "system_instruction": {"parts": [{"text": system_prompt}]},
    "contents": [{"parts": parts}],
    "generationConfig": {"temperature": 0.9, "maxOutputTokens": 65536}
}

req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"}, method="POST")

print(f"Calling {MODEL} (temp=0.9)...")
with urllib.request.urlopen(req, timeout=240) as resp:
    result = json.loads(resp.read())

text = result["candidates"][0]["content"]["parts"][0]["text"]
if "```html" in text:
    s = text.index("```html") + 7
    text = text[s:text.index("```", s)].strip()
elif "```" in text:
    s = text.index("```") + 3
    s = text.index("\n", s) + 1
    text = text[s:text.index("```", s)].strip()

out = "/tmp/rustify-band-detail-v3.html"
with open(out, "w") as f:
    f.write(text)
print(f"OK: {len(text)} chars → {out}")
u = result.get("usageMetadata", {})
print(f"Tokens: prompt={u.get('promptTokenCount','?')} response={u.get('candidatesTokenCount','?')} thoughts={u.get('thoughtsTokenCount','?')}")
