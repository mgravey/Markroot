# Compatibility fixtures

`kitchen-sink.qmd` is the first non-executable QMD golden fixture. It covers front matter, references, math, cross-references, figures, layouts, callouts, tables, nested lists, code cells, and raw blocks. `references.bib` and `figure.svg` are intentionally local dependencies.

The fixture is used by contract tests for stable source blocks and inert execution warnings. Native Pandoc/Quarto HTML, DOCX archive, and Typst PDF goldens remain release-gate artifacts because they must be pinned to exact engine versions and compared semantically rather than as unstable raw bytes.
