import { cases } from './cases.mjs';

const [name, workspace] = process.argv.slice(2);
await cases.get(name).verify(workspace);
console.log('acceptance checks completed');
