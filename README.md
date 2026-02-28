# RouteTracer — Cycling Route Visualizer

Animated cycling route tracing on real interactive maps with a synchronized elevation profile.

## Features

- **Real interactive maps** via Leaflet + OpenStreetMap (free, no API keys needed)
- **4 map styles**: Dark, Street, Topographic, Satellite
- **Animated route tracing** with grade-colored segments (green/amber/orange/red)
- **Synced elevation profile** that draws in real time as the route traces
- **Live stats**: distance, elevation gain, max elevation, grade percentage
- **GPX/TCX file import** — load any cycling route file
- **Image upload** (placeholder for AI Vision route extraction)
- **Speed control**: 0.5× to 4×

## Quick Start (Local)

Just open `index.html` in any modern browser. No build step, no dependencies to install, no API keys.

```
open index.html
```

## Deploy to Vercel

1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) and import the repo
3. Vercel auto-detects it as a static site — click Deploy
4. Done! Your app is live.

Or use the Vercel CLI:

```bash
npm i -g vercel
cd route-tracer-prod
vercel
```

## Map Tile Sources (all free, no keys)

| Style     | Provider       | Tiles                                          |
|-----------|---------------|------------------------------------------------|
| Dark      | CARTO         | Dark Matter basemap                            |
| Street    | OpenStreetMap | Standard OSM tiles                             |
| Topo      | OpenTopoMap   | Topographic with contour lines                 |
| Satellite | Esri          | World Imagery                                  |

## Roadmap

- [ ] AI Vision route extraction from screenshots (Claude API)
- [ ] Computer Vision color-detection route tracing
- [ ] Elevation API integration for imported routes without elevation data
- [ ] Shareable route links
- [ ] Route export (GPX, KML)
