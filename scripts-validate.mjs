import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js');
const root = process.cwd();
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','dist','.git'].includes(e.name)) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) walk(p);
    else if(/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
}
walk(root);
let failed=false;
for(const f of files){
  const source=fs.readFileSync(f,'utf8');
  const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true,fileName:f});
  const errors=(out.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length){ failed=true; console.error(`\n${path.relative(root,f)}`); for(const d of errors) console.error(ts.flattenDiagnosticMessageText(d.messageText,'\n')); }
}
if(failed) process.exit(1);
console.log(`Syntax/transpile validation passed: ${files.length} TypeScript/TSX files.`);
