#!/usr/bin/env python3
"""Builds dist/index.html: one self-contained page (shell + d3 + data + dashboard)."""
import os, pathlib
here = pathlib.Path(__file__).parent
shell = (here / "src/shell.html").read_text()
d3 = (here / "vendor/d3.min.js").read_text()
data = (here / "src/followers_monthly.json").read_text()
page = (here / "src/page.html").read_text()
for name, text in (("d3", d3), ("data", data)):
    assert "</script" not in text.lower(), f"{name} contains </script"
out = (shell.replace("/*D3*/", "\0D3\0").replace("/*DATA*/", "\0DATA\0").replace("/*PAGE*/", "\0PAGE\0")
       .replace("\0PAGE\0", page).replace("\0DATA\0", data).replace("\0D3\0", d3))
version = os.environ.get("GITHUB_SHA", "local")[:8]
out = out.replace("<head>", f"<head>\n<!-- build {version} -->", 1)
(here / "dist").mkdir(exist_ok=True)
(here / "dist/index.html").write_text(out)
print(f"dist/index.html: {len(out):,} bytes")
