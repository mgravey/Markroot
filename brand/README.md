# Markroot identity

The symbol is a **rooted pilcrow**: the conventional paragraph mark grows into a three-way root system. It connects scholarly writing, Markdown structure, local files, and the Markroot name without depending on a letterform.

## Files

- `markroot-animation-preview.svg` — static presentation board
- `markroot-motion-preview.svg` — looping browser preview of the motion
- `after-effects/MarkrootLogo.jsx` — After Effects composition generator
- `../apps/web/public/brand/markroot-mark.svg` — production SVG
- `../apps/web/public/favicon.svg` — simplified 64-unit favicon
- `../apps/web/public/brand/markroot-{32,180,192,512}.png` — browser, touch, and install surfaces
- `../apps/web/public/brand/markroot-mask.svg` — monochrome pinned-tab mark
- `../apps/web/public/manifest.webmanifest` — app identity metadata

## After Effects and Lottie

1. In After Effects, choose **File → Scripts → Run Script File…** and select `MarkrootLogo.jsx`.
2. Open the generated `MARKROOT_LOGO_ANIMATION` composition.
3. Export it through Bodymovin or the LottieFiles plug-in as SVG-based Lottie JSON.
4. Keep glyphs as shapes and enable glyph/shape export. The script uses shape paths, fills, strokes, Trim Paths, scale, position, and opacity only.
5. The composition is 512 × 512, 30 fps, and 2.4 seconds. Marker `final-logo` identifies the settled brand frame; the last frame is identical to the static SVG.

The animation sequence is seed → tile → roots → pilcrow → cursor. It plays once and then holds the complete logo while only the orange cursor continues blinking. The deployed interface starts directly on this final state and uses only the cursor blink; it never repeatedly rebuilds the mark. Reduced-motion preferences disable all motion and leave the complete logo visible.

## Colour

- Root teal: `#006f62`
- Warm cursor: `#ef9163`
- White glyph: `#ffffff`

The favicon deliberately keeps the same geometry and colours. At 16 px the orange cursor becomes a tiny warm glint; the white pilcrow/root silhouette remains the primary read.
