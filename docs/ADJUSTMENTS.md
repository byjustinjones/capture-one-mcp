# Adjustment round-trip findings

Capture One Pro 16.8.5, probed against a live variant in the standing test
session. Raw data: [`adjustment-round-trip.json`](./adjustment-round-trip.json),
regenerate with `node scripts/verify-adjustments.mjs`.

The `adjustment settings` class declares **90 properties**. Seven are structured
objects (five curves, the colour editor, and dehaze colour) and are out of scope
for the patch tool. The remaining **83 scalars** are all declared read-write, and
each was probed in three phases: write back its own value, write a small delta,
then bisect for the values the app actually accepts.

## Summary

| Outcome | Count |
| --- | --- |
| Round-trips exactly | 62 |
| Requantised on read-back | 1 (`tint`; `temperature` behaves the same way) |
| Modular — wraps instead of clamping | 4 (colour-balance hues) |
| Probe overshot the property's ceiling | 13 (see below — **not** broken) |
| Text-valued, no safe synthetic value | 3 (`color_profile`, `film_curve`, `white_balance_preset`) |

**The 13 "write errors" are an artefact of the probe, not broken properties.**
Twelve are ceiling overshoot: the delta phase writes `original + 1`, which
overshoots when the original already sits at the maximum — `level_highlight_rgb`
starts at 255 with a ceiling of 255, and the four colour-balance saturations
start near 0 with a ceiling of 1. The thirteenth is `orientation`, rejected for a
different reason: it accepts only the discrete set 0/90/180/270, so `90 + 1` is
invalid at any magnitude.
Both accept ordinary in-range values — `level_highlight_rgb: 200` and
`orientation: 180` were confirmed to apply and read back exactly.

## Things the dictionary does not tell you

### Ranges are not declared anywhere, and the error messages lie

The sdef declares no ranges. Capture One rejects out-of-range writes with a
message that *looks* authoritative — and for some properties is simply wrong:

```
level_highlight_rgb = 256  ->  "Cannot set this value above 1."
level_highlight_rgb = 255  ->  accepted, reads back 255
level_highlight_rgb = 200  ->  accepted, reads back 200
```

The real range is 0–255; the message reports 1. An earlier version of
`adjustment-ranges.ts` trusted that text and would have rejected every
legitimate value from 2 to 255 across all sixteen `level_*` properties. Ranges
are therefore found by **bisecting against the live app**, treating a bound as
accepted only when the write succeeds *and* the value reads back unchanged — a
silent clamp shows up as a successful write with a different read-back.

### Floats are requantised

`temperature` and `tint` are stored at lower precision than they are accepted:

```
temperature = 5500   ->  reads back 5500.001465
tint        = 3      ->  reads back 2.999979
```

Nothing is wrong, but an exact-equality check on a read-back will report a
mismatch. `co_adjust_variants` reports `requested`, `actual` and `matched` per
property so this is visible rather than hidden behind a bare success.

### The colour-balance hues are modular and cannot be zeroed again

`color_balance_{master,shadow,midtone,highlight}_hue` wrap rather than clamp.
Writing `0` reads back as `360`, and once a variant has been written there is no
scripted way to return it to `0`:

```
hue = 0     ->  reads 360
hue = 0     ->  still 360   (repeat writes do not help)
saturation = 0  ->  reads 0.000033378600278410886
```

Hue 360 is the same hue as 0, and a saturation of 3.3e-5 is 0.003% — the colour
balance is neutral either way — but the stored numbers no longer match. These
four are flagged `modular: true` and are deliberately **not** range-validated,
since their bounds cannot be measured.

The practical consequence is for restore logic: **never write a value that is
already correct.** An unconditional restore that rewrote all 83 properties
dirtied variants it was meant to leave untouched, because writing `0` to an
already-`0` hue moves it to `360`. `scripts/testbed.mjs` now compares before
writing.

### `orientation` accepts only four values

`0`, `90`, `180`, `270`. This is the one property whose error message is
trustworthy, and the only one with a discrete `allowed` set.

## Measured ranges

Generated into [`../src/co/adjustment-ranges.ts`](../src/co/adjustment-ranges.ts)
by `scripts/gen-adjustment-ranges.mjs`. A sample of the non-obvious ones:

| Property | Range |
| --- | --- |
| `exposure` | −4 … 4 |
| `contrast`, `brightness`, `tint` | −50 … 50 |
| `saturation` | −100 … 100 |
| `temperature` | 800 … 14000 |
| `rotation`, `keystone_skew` | −45 … 45 |
| `keystone_vertical`, `keystone_horizontal` | −75 … 75 |
| `keystone_amount` | 10 … 120 |
| all sixteen `level_*` | 0 … 255 |
| `color_balance_*_saturation` | 0 … 1 |
| `color_balance_*_lightness` | −1 … 1 |
| `sharpening_amount` | 0 … 1000 |
| `sharpening_radius` | 0.2 … 2.5 |
| `vignetting_amount` | −4 … 4 |
| `orientation` | 0, 90, 180, 270 only |

No property was found to be unbounded.
