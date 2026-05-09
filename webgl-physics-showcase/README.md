# WebGL Physics Showcase

A standalone WebGL2 GPU-water physics showcase built without external packages.

## Features

- GPU ping-pong framebuffer simulation
- Float texture water state: height + velocity
- Shader-sampled normal reconstruction
- Fresnel-style reflective water shading
- Full-water chamber composition
- Draggable sphere with wake generation
- Double-click shockwave burst
- Brush radius and strength controls
- Reset, slow motion, gravity, cinematic overlay, and HUD controls
- Sphere material selector: ceramic, chrome, glass
- Static HTML/CSS/JS, no build step required

## Run locally

Open `index.html` directly in a modern browser, or serve it with a local server:

```bash
python -m http.server 8000
```

Then open:

```txt
http://localhost:8000
```

## GitHub Pages

This repo includes a GitHub Pages workflow in `.github/workflows/pages.yml`.
After pushing to GitHub, enable Pages using GitHub Actions as the source.

## Browser requirements

- WebGL2
- `EXT_color_buffer_float`

Modern Chrome, Edge, and Firefox should work.
