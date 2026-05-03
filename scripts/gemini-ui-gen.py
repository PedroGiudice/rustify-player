import json, os, base64, urllib.request

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL = "gemini-3.1-pro-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

with open("/home/opc/rustify-player/docs/ui-generation-system-prompt.md") as f:
    system_prompt = f.read()

user_prompt = """## Smart Columns EQ — Interactive Prototype

I'm attaching the REAL app screenshot (Signal view) as ground truth for visual style, colors, fonts, and layout.

### Concept: "Smart Columns"

Replace the traditional vertical slider faders with **large invisible rectangular column hitboxes** per frequency band. The interaction model is fundamentally different from sliders:

1. **Click-to-set**: Each band is a tall rectangular column (~40px wide × 200px tall). Clicking ANYWHERE in the column instantly sets the gain to match the cursor's Y position. No tiny slider thumb to grab — the entire column is the hitbox.

2. **Draw Mode (continuous swipe)**: Click and hold, then drag horizontally across all columns to "draw" the EQ curve in one fluid motion. As the mouse crosses each column boundary, that band's gain updates to the cursor's Y position. This is the killer feature — sculpt the entire EQ curve with one mouse gesture.

3. **Precision inputs preserved**: Below each column, a small numeric input field shows the current dB value. Users can click into it and type exact values (e.g., 5.5 or -3.2). Tab key moves to the next band's input — perfect for importing AutoEQ profiles quickly: click first input, type 3, Tab, -1, Tab, 5.5, etc.

### Visual spec for each column

- **Column area**: Full height (~200px), ~40px wide per band, no visible border in default state
- **Fill bar**: From the zero line (vertical center) to the current gain position. Color: `var(--primary)` at 60% opacity. Fills upward for positive gain, downward for negative.
- **Zero line**: Horizontal mark at vertical center, `var(--divider-hi)`, 100% of column width, 1px tall
- **Hover state**: Column background becomes `var(--surface-container)` (subtle highlight showing the hitbox)
- **Active/selected band**: Column background slightly brighter, fill bar at 80% opacity, frequency label turns `var(--primary)`
- **Frequency label**: Above each column, small text: 25, 40, 63, 110, 190, 330, 550, 1.3k, 1.4k, 3.0k, 5.7k, 8.0k, 12k, 16k, 17k, 20k
- **Gain value input**: Below each column, editable `<input type="number">` showing dB value (e.g., +5.5, -2.2, 0.0). Styled minimal: no spinner, `var(--text-label-xs)`, centered under column. Step: 0.1.

### Y-axis scale

- Range: -30dB to +30dB
- Y-axis labels on the left: +30, +18, +6, 0, -6, -18, -30
- Grid lines: subtle horizontal lines at each label, `var(--divider)` at 30% opacity

### Other sections (keep from current design)

1. **Canvas/graph above**: 170px height SVG frequency response curve. Orange polyline (`var(--primary)`, stroke-width 2) with small circles (r=4) at each band position. The curve should reflect the gain values of the columns in real-time as they change.

2. **X-axis labels**: Between canvas and columns: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k — logarithmic scale feel.

3. **Band detail panel**: Horizontal strip below columns showing selected band info:
   ```
   Band 1 · 25 Hz · Bell                    Type [Bell ▼]   Mode [APO (DR) ▼]   Slope [x1 ▼]   Q: 0.70   [S] [M]
   ```

4. **Mode selector**: IIR, FIR, FFT, SPM buttons. FFT active by default.

5. **Input/Output meters**: Horizontal bars with dB readout.

6. **Header**: "Parametric Equalizer" in `var(--font-display)`, bold. Right side: "LSP x16 Stereo" label + toggle pill.

### Initial data (16 bands)

| Band | Freq | Gain |
|------|------|------|
| 1 | 25 | -0.1 |
| 2 | 40 | 0.0 |
| 3 | 63 | 0.0 |
| 4 | 110 | +5.5 |
| 5 | 190 | +2.0 |
| 6 | 330 | +1.4 |
| 7 | 550 | -1.5 |
| 8 | 1.3k | +2.0 |
| 9 | 1.4k | +6.0 |
| 10 | 3.0k | -2.2 |
| 11 | 5.7k | -2.6 |
| 12 | 8.0k | -5.1 |
| 13 | 12k | -5.2 |
| 14 | 16k | 0.0 |
| 15 | 17k | 0.0 |
| 16 | 20k | +0.1 |

### Interactivity requirements (ALL must work)

1. **Click anywhere in a column** → gain jumps to that Y position instantly
2. **Click + drag horizontally** → draw mode: each column crossed updates its gain to cursor Y
3. **Click + drag vertically within one column** → fine-adjust that band's gain
4. **Hover a column** → subtle background highlight
5. **Click a column** → selects that band (updates band detail panel)
6. **Type in input field** → updates gain + fill bar + SVG curve
7. **Tab between inputs** → moves focus to next band's input
8. **SVG curve updates** in real-time as any gain value changes

### Critical: What makes this DIFFERENT from sliders

- There is NO slider thumb/knob to grab. The entire column IS the control.
- The clickable area is ~40×200px instead of ~12×12px (a thumb). This is ~55x larger.
- Draw mode lets you sculpt the whole EQ curve in ONE mouse gesture.
- The visual metaphor is a bar chart that you can paint, not a row of sliders.

### Output

Single complete HTML file with inlined CSS and JS. Google Fonts for Inter and Fraunces. ALL interactivity must be functional. This is a prototype for testing the Smart Columns interaction model."""

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

out = "/tmp/rustify-smart-columns-v1.html"
with open(out, "w") as f:
    f.write(text)
print(f"OK: {len(text)} chars → {out}")
u = result.get("usageMetadata", {})
print(f"Tokens: prompt={u.get('promptTokenCount','?')} response={u.get('candidatesTokenCount','?')} thoughts={u.get('thoughtsTokenCount','?')}")
