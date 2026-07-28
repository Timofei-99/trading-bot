import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PlotlyFigure } from './plotly-figure.builder';

const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-2.35.2.min.js';

/**
 * Write a figure as a standalone HTML page.
 *
 * Plotly itself comes from the CDN rather than the bundle — the same choice
 * the Python code made with `include_plotlyjs="cdn"`, which keeps a 3 MB
 * library out of the repository and out of `node_modules`.
 */
export function writeFigureHtml(path: string, figure: PlotlyFigure, title = 'chart'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderFigureHtml(figure, title), 'utf8');
}

export function renderFigureHtml(figure: PlotlyFigure, title = 'chart'): string {
  // `</script>` inside the payload would end the tag early; escaping the slash
  // is inert in JSON and safe in HTML.
  const payload = JSON.stringify(figure).replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="${PLOTLY_CDN}" charset="utf-8"></script>
<style>
  html, body { margin: 0; padding: 0; background: #131722; }
  #chart { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="chart"></div>
<script>
  const figure = ${payload};
  Plotly.newPlot('chart', figure.data, figure.layout, { responsive: true });
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
