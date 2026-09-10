# Layers and masks: findings

Capture One Pro 16.8.5, verified against the standing test session.

## What the scripting interface can and cannot do

| Capability | Status |
| --- | --- |
| Create layers | Yes — **adjustment layers only** |
| Set name / enabled / opacity | Yes, except on the background layer |
| Layer adjustments (all 83 properties) | Yes; each written value is read back (the full 83-property probe was run against a variant, not a layer) |
| Luma range (7 fields) | Yes, fully verified by read-back |
| Mask operations (invert, feather, refine, copy) | Commands work — **but are unverifiable** |
| Mask replacement (clear, fill, rasterize) | Works; destructive-tier — **unverifiable** |
| AI people masking | Yes, verified by the layers it produces |
| Delete layers | Yes, except the background layer |

### Layer kind cannot be chosen

`layer.kind` is read-only, so `make new layer` always produces an `adjustment`
layer. The `layer type` enumeration also lists `clone`, `heal`, `filled`,
`subject mask`, `background mask` and `background`, but none of those can be
created through scripting. Even the AI people-mask layers come back as kind
`adjustment`, not `subject mask`.

Layers have **no `id` property**, so they are addressed positionally. Index 0 is
always the background layer — the dictionary notes an Image Layer reports its
name and kind as `background` for backward compatibility.

### The background layer rejects both opacity and name changes

The dictionary declares `opacity` and `name` read-write on `layer` with no
exceptions. The background layer refuses both:

```
layer[0].opacity = 50          ->  "Cannot change Background's opacity."
layer[0].name    = "anything"  ->  "Cannot rename the Background layer."
```

`co_delete_layer` refuses the background layer up front rather than letting the
attempt reach Capture One. `co_set_layer` does not refuse it up front — Capture
One's own rejection is the authority — but it writes each field independently and
reports the refusal per field, so a rejected opacity no longer discards a
successful name change.

## Masks cannot be verified

This is the one place in this server where a write cannot be checked.

The `layer` class exposes **no mask property** — there is no way to read a
mask's coverage, its bounds, or even whether it is empty. The only pixel-sampling
objects are `readout`s, and they cannot be created either: their
`horizontal position` and `vertical position` are read-only, so
`make new readout` fails with *"You cannot set or change this property of this
object."*

So `co_mask_edit`, `co_mask_replace` and `co_copy_mask` report `accepted: true` and
`verified: false`, with a note saying so. They confirm the command was accepted,
nothing more. Every other write in this server is confirmed by read-back; these
are the exception, and they say so rather than implying otherwise.

## AI people masking

`create people mask` works and takes 4–6 seconds per variant. It is verifiable
indirectly, because the layers it creates *are* readable.

**Layers are created per area DETECTED, not per area requested.** Asking for
four areas on an image with a person yielded two layers:

```
requested: ["body skin", "face skin", "hair", "clothes"]
created  : ["Body Skin Mask 1", "Face Skin Mask 1"]
```

That is partial detection, not a failure, and `co_create_people_mask` reports it
as such rather than leaving the caller to infer it from a count.

`separate layers` genuinely changes behaviour, visible in the naming:

| Setting | Result |
| --- | --- |
| `separate_layers: true` | One layer per detected area — `Hair Mask 1`, `Body Skin Mask 1` |
| `separate_layers: false` | One combined layer — `People Mask 1` |

When no people are present, Capture One raises `"No people detected."` — an
explicit error rather than silence, so the no-op case is distinguishable from a
refusal. Of eight frames sampled across this lens-testing session, three
contained people.

## Restore implications

The testbed harness snapshots layers positionally and, on restore, deletes any
layer beyond the baseline count before fixing names, enabled state and opacity
on the rest. Deleting is bounded to the surplus, so it can never remove a layer
the baseline recorded.
