const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'desktop/assets/icon.svg'), 'utf8');
const image = new Resvg(source, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
fs.writeFileSync(path.join(root, 'desktop/assets/icon.png'), image);
