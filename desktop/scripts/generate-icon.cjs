const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'desktop/assets');
const source = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
const themes = {
  white: { background: '#FFFFFF', foreground: '#1C2422' },
  black: { background: '#111111', foreground: '#F4F2EC' },
  sage: { background: '#DCEBCF', foreground: '#1C2422' },
  blue: { background: '#DDEBFF', foreground: '#182B47' },
  orange: { background: '#FFDEC5', foreground: '#48291C' },
};

for (const [name, colors] of Object.entries(themes)) {
  const svg = source
    .replaceAll('#FFFFFF', colors.background)
    .replaceAll('#1C2422', colors.foreground);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
  fs.writeFileSync(path.join(assets, `icon-${name}.png`), png);
}
fs.copyFileSync(path.join(assets, 'icon-white.png'), path.join(assets, 'icon.png'));
