#!/usr/bin/env python3
"""Rasterize public/examples/*.pdf into centered black-stroke PNG previews."""

from __future__ import annotations

import math
import pathlib
import re
from collections import Counter

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1] / "public" / "examples"
W, H = 320, 200
PAD = 18


def content_stream(pdf: pathlib.Path) -> str:
    data = pdf.read_bytes()
    text = data.decode("latin1")
    m = re.search(r"<< /Length \d+ >>\nstream\n", text)
    if not m:
        raise SystemExit(f"no content stream in {pdf.name}")
    return text[m.end() : text.find("endstream", m.end())]


def cubic(p0, p1, p2, p3, n: int = 16):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (
            u * u * u * p0[0]
            + 3 * u * u * t * p1[0]
            + 3 * u * t * t * p2[0]
            + t * t * t * p3[0],
            u * u * u * p0[1]
            + 3 * u * u * t * p1[1]
            + 3 * u * t * t * p2[1]
            + t * t * t * p3[1],
        )


def parse_polylines(stream: str):
    """Yield closed/open polylines sampled from PDF path ops (handles cubics)."""
    parts = re.split(r"\n(?=[0-9.]+ [0-9.]+ [0-9.]+ RG)", stream)
    for part in parts:
        if " RG" not in part:
            continue
        toks = re.findall(r"[+-]?(?:\d+\.\d*|\.\d+|\d+)|[A-Za-z*]+", part)
        nums: list[float] = []
        cur = None
        start = None
        closed = False
        poly: list[tuple[float, float]] = []

        def flush():
            nonlocal poly, closed, cur, start
            if len(poly) >= 2:
                yield list(poly), closed
            poly = []
            closed = False
            cur = None
            start = None

        i = 0
        while i < len(toks):
            t = toks[i]
            if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+|\d+)", t):
                nums.append(float(t))
                i += 1
                continue
            op = t
            i += 1
            if op == "m" and len(nums) >= 2:
                if len(poly) >= 2:
                    yield from flush()
                x, y = nums[-2], nums[-1]
                nums.clear()
                cur = (x, y)
                start = cur
                poly = [cur]
            elif op == "l" and len(nums) >= 2 and cur is not None:
                x, y = nums[-2], nums[-1]
                nums.clear()
                cur = (x, y)
                poly.append(cur)
            elif op == "c" and len(nums) >= 6 and cur is not None:
                c1 = (nums[-6], nums[-5])
                c2 = (nums[-4], nums[-3])
                p = (nums[-2], nums[-1])
                nums.clear()
                samples = list(cubic(cur, c1, c2, p, 20))
                poly.extend(samples[1:])
                cur = p
            elif op == "v" and len(nums) >= 4 and cur is not None:
                c2 = (nums[-4], nums[-3])
                p = (nums[-2], nums[-1])
                nums.clear()
                samples = list(cubic(cur, cur, c2, p, 20))
                poly.extend(samples[1:])
                cur = p
            elif op == "y" and len(nums) >= 4 and cur is not None:
                c1 = (nums[-4], nums[-3])
                p = (nums[-2], nums[-1])
                nums.clear()
                samples = list(cubic(cur, c1, p, p, 20))
                poly.extend(samples[1:])
                cur = p
            elif op == "h":
                closed = True
                if start is not None and cur is not None:
                    if math.hypot(cur[0] - start[0], cur[1] - start[1]) > 1e-4:
                        poly.append(start)
                    cur = start
            elif op in ("S", "s", "B", "B*", "b", "b*", "f", "f*", "F"):
                if op in ("s", "b", "b*", "f", "f*", "F", "B", "B*"):
                    closed = True
                yield from flush()
                nums.clear()
            else:
                nums.clear()
        if len(poly) >= 2:
            yield from flush()


def render(pdf: pathlib.Path) -> pathlib.Path:
    stream = content_stream(pdf)
    polys = list(parse_polylines(stream))
    if not polys:
        raise SystemExit(f"no paths in {pdf.name}")
    xs = [p[0] for poly, _ in polys for p in poly]
    ys = [p[1] for poly, _ in polys for p in poly]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    bw = max(maxx - minx, 1e-6)
    bh = max(maxy - miny, 1e-6)
    # Uniform scale + equal margins (left=right, top=bottom)
    s = min((W - 2 * PAD) / bw, (H - 2 * PAD) / bh)
    ox = (W - bw * s) / 2
    oy = (H - bh * s) / 2

    def xy(p):
        return (ox + (p[0] - minx) * s, oy + (p[1] - miny) * s)

    im = Image.new("RGB", (W, H), (255, 252, 248))
    dr = ImageDraw.Draw(im)
    for poly, closed in polys:
        seq = [xy(p) for p in poly]
        if closed and seq and seq[0] != seq[-1]:
            seq.append(seq[0])
        if len(seq) >= 2:
            dr.line(seq, fill=(0, 0, 0), width=2)
    out = pdf.with_suffix(".png")
    im.save(out, optimize=True)
    return out


def main():
    for pdf in sorted(ROOT.glob("*.pdf")):
        out = render(pdf)
        print(f"wrote {out.name} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
