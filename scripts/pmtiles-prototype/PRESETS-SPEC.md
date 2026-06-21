# Layout presets — Clean & Detailed

**Status**: Spec, not implementation. Lives on the spike branch so the
preset definitions evolve alongside the data path (PMTiles) that will
serve them.

## What already exists

The behaviour is shipped today:

| Layer | Field | Values |
|---|---|---|
| Studio form | `roadDetailMode` | `'arteries'` \| `'neighbourhood'` |
| Studio → server body | `minorRoads` | `boolean` (true = neighbourhood) |
| Render-service Python | `minor_roads` | `bool` parameter on `render()` |
| Tier filter | `_CLEAN_HIDDEN_TYPES` | hides secondary/tertiary/residential when `False` |

The two visual outputs already render correctly. What's missing is
purely structural: there's no named "preset" abstraction. A `bool` flag
is a fine implementation but a weak API surface — it doesn't compose
with future per-preset tunings (different fade styles, different edge
weights, different DPI defaults) without adding parallel parameters.

## What this spec adds

A `RENDER_PRESETS` dict that clusters the existing tier filter with
future per-preset knobs, and a `preset` field on the studio→server
contract that supersedes the `minor_roads` bool one release at a time.
Same two visual outputs, cleaner API.

This work lands AFTER the PMTiles spike validates, because the dict's
home should be the new render path, not retrofitted into the OSMnx path
we're about to retire.

## Why promote it now

Naming the existing toggle as a preset elevates the choice from a
per-render setting to a **product positioning lever**:

- **Clean** — major arteries only, no secondary / tertiary roads, strong
  geometry, lots of breathing room. Premium feel at smaller sizes
  (16×20). Continues the direction of render-service PR #28.
- **Detailed** — full road hierarchy, finer grid, more city texture.
  Reads better at large formats (24×36+) where density adds to the
  "wow" effect at close viewing distance.

Same city + same theme + two depth presets = two distinct products that
appeal to different customer aesthetics.

## How they sit in the PMTiles pipeline

Both presets read from the **same PMTiles archive**. The archive carries
every `highway=` tag value verbatim — per `scripts/pmtiles-prototype/
tilemaker-process.lua`, the Lua keeps the raw tag string as an MVT
attribute rather than collapsing it into a tier-numeric. Tier filtering
happens at draw time:

| Preset | Filter | Today's equivalent |
|---|---|---|
| Clean | hide `_CLEAN_HIDDEN_TYPES` | `minor_roads=False` |
| Detailed | hide nothing | `minor_roads=True` |

Consequences:

- **Zero storage delta** between presets — single archive serves both.
- **Zero build delta** — no separate tile rebuilds when introducing or
  refining a preset.
- **Re-render, not re-fetch** — moving an existing order from Clean to
  Detailed is a matplotlib pass over already-cached MVT features. No
  data round-trip.

## DPI policy

| Path | DPI | Rationale |
|---|---|---|
| Preview (modal) | 96–120 | Client-side via `runExportPipeline`; 1–2 s on mid-range mobile |
| Fulfillment (Gelato → POD) | **400** | Print-grade; museum / giclée standard |
| Floor | **300** | Never go below — hard rule across all paths |
| 600 DPI | Not justified at current size range | Revisit only if 30×40"+ formats launch and the lab requests it |

Vector tiles make DPI a pure rasterization parameter — same source
geometry, different resolutions at matplotlib `savefig(dpi=…)` time. No
raster upscaling, no resampling artifacts. The studio doesn't need to
ship a separate 400 DPI asset; it requests a 400 DPI render and gets one.

## API surface

### Render-service Python

A single dict centralises preset definitions; the existing
`get_edge_colors` / `get_edge_widths` / `_CLEAN_HIDDEN_TYPES` plumbing
adopts the dict in place of the `minor_roads: bool` parameter.

```python
RENDER_PRESETS = {
    "clean": {
        "hidden_highway":    _CLEAN_HIDDEN_TYPES,
        "edge_width_scale":  1.0,
        # Future levers per-preset (gradient fade style, line weights, etc.)
        # land here without rippling through call sites.
    },
    "detailed": {
        "hidden_highway":    frozenset(),
        "edge_width_scale":  1.0,
    },
}
```

Callers shift from:
```python
edge_colors = get_edge_colors(g_proj, theme, minor_roads=False)
```
to:
```python
edge_colors = get_edge_colors(g_proj, theme, preset=RENDER_PRESETS["clean"])
```

`minor_roads` is kept on the function signature for one release as a
deprecation alias, then removed.

### Studio → render-service contract

| Today | After cut-over |
|---|---|
| `minorRoads: boolean` | `preset: "clean" \| "detailed"` |
| (no DPI field — server picks) | `dpi: number` (optional, server clamps to ≥300 for fulfillment) |

Backwards-compat window: server accepts both `minorRoads` and `preset`
for one release. When both are present, `preset` wins. After the
deprecation window, only `preset` is accepted.

### Studio UI surfacing

**Out of scope for the spike branch.** Two product directions to decide
separately:

1. **Preset as checkout option** — alongside finish and size, the
   customer picks Clean or Detailed as part of ordering. Higher friction,
   clearer positioning, supports tier pricing if Detailed becomes a
   premium SKU.
2. **Preset as editor setting only** — current behaviour, preserved.
   Customer toggles during design; whatever they last had selected is
   what fulfils.

Both work technically. Decision is product, not engineering.

## Cut-over sequence

1. **(this branch)** PMTiles spike validates DC at both presets — done
   via the 4-panel comparison in `render-comparison.py`.
2. Planet build + R2 upload.
3. Production render path adopts PMTiles + `RENDER_PRESETS` dict. Single
   PR on `mapvibe-render-service`.
4. Studio sends explicit `preset` field instead of `minorRoads`. Single
   PR on `mapvibe-studio`.
5. Studio surfaces preset as product option (if that's the decision in
   the "UI surfacing" section above). Separate PR, product-led.

Steps 3–5 are independent and can ship in either order: backwards-compat
shims on each side let them roll out asynchronously.

## What the spike validates

The 4-panel comparison in `render-comparison.py` renders DC as:

```
+----------------------+----------------------+
| OSMnx — Clean        | PMTiles — Clean      |
+----------------------+----------------------+
| OSMnx — Detailed     | PMTiles — Detailed   |
+----------------------+----------------------+
```

Pass criteria:
- **Top row identical between left & right** → PMTiles data is correct
  for Clean preset, tier-filter is honoured.
- **Bottom row identical between left & right** → PMTiles data is
  complete (all minor road tiers present, none lost in Tilemaker
  simplification).
- **Top row visibly sparser than bottom** within each column → preset
  filter is doing its job; Clean really hides the lower tiers.

If any of those fail, the fix is in `tilemaker-process.lua` (missing tag
preservation) or this spec (preset definition wrong). Both findable and
fixable before any planet-scale commitment.
