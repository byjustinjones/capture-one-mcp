#!/usr/bin/env python3
"""Render the Capture One .sdef into a readable Markdown digest.

Run against the installed app so the digest always reflects the real build:
    python3 scripts/gen-dictionary.py > docs/DICTIONARY.md
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

SDEF = os.environ.get(
    "CO_SDEF", "/Applications/Capture One.app/Contents/Resources/CaptureOne.sdef"
)


def typename(el):
    types = el.findall("type")
    if types:
        return " | ".join(
            (t.get("type") or "?") + ("[]" if t.get("list") == "yes" else "") for t in types
        )
    return (el.get("type") or "any") + ("[]" if el.get("list") == "yes" else "")


def tier(desc):
    m = re.match(r"\((PRO|CH|Enterprise)[^)]*\)\s*", desc or "")
    return (m.group(1), (desc or "")[m.end():]) if m else (None, desc or "")


def main():
    root = ET.parse(SDEF).getroot()
    version = os.environ.get("CO_VERSION", "installed build")
    print(f"# Capture One scripting dictionary ({version})\n")
    print(
        "Generated from the installed app's `CaptureOne.sdef` by "
        "`scripts/gen-dictionary.py`. Do not hand-edit.\n"
    )
    print(
        "Tier markers come from the dictionary itself: **PRO** = Capture One Pro only, "
        "**CH** = Cultural Heritage, **Enterprise** = Enterprise only.\n"
    )

    for suite in root.findall("suite"):
        if suite.get("name") != "Capture One Suite":
            continue

        print("## Commands\n")
        for c in sorted(suite.findall("command"), key=lambda x: x.get("name")):
            name = c.get("name")
            if name.startswith("test "):
                continue  # internal test harness verbs, not for consumers
            lvl, desc = tier(c.get("description"))
            direct = c.find("direct-parameter")
            result = c.find("result")
            sig = f"### `{name}`"
            if lvl:
                sig += f"  _({lvl} only)_"
            print(sig)
            if direct is not None:
                print(f"- target: `{typename(direct)}`")
            for p in c.findall("parameter"):
                opt = "optional" if p.get("optional") == "yes" else "**required**"
                print(f"- param `{p.get('name')}`: `{typename(p)}` ({opt})")
            if result is not None:
                print(f"- returns: `{typename(result)}`")
            if desc:
                print(f"\n{desc.strip()}")
            print()

        print("## Classes\n")
        classes = list(suite.findall("class")) + list(suite.findall("class-extension"))
        for c in classes:
            name = c.get("name") or c.get("extends")
            print(f"### `{name}`")
            if c.get("inherits"):
                print(f"_inherits from `{c.get('inherits')}`_\n")
            elements = [e.get("type") for e in c.findall("element")]
            if elements:
                print(f"- contains: {', '.join(f'`{e}`' for e in elements)}")
            props = c.findall("property")
            if props:
                print("\n| property | type | access |")
                print("| --- | --- | --- |")
                for p in props:
                    acc = {"r": "read-only", "w": "write-only"}.get(p.get("access", "rw"), "rw")
                    print(f"| `{p.get('name')}` | `{typename(p)}` | {acc} |")
            print()

        print("## Enumerations\n")
        for e in sorted(suite.findall("enumeration"), key=lambda x: x.get("name")):
            vals = ", ".join(f"`{v.get('name')}`" for v in e.findall("enumerator"))
            print(f"- **{e.get('name')}**: {vals}")


if __name__ == "__main__":
    if not os.path.exists(SDEF):
        sys.exit(f"sdef not found at {SDEF}; set CO_SDEF to override")
    main()
