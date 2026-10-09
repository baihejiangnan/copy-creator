// Compile a trusted frozen store into a literal CDP expression. Never disable
// product CSP and never construct code in the browser from runtime user data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const app=path.resolve(__dirname,'../copy-creator'),ts=require(require.resolve('typescript',{paths:[app]}));
exports.reference=()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../output/optimization/R0-20261007/source/copy-creator/src/stores/clipboardStore.ts'),'utf8');
 const vanilla=fs.readFileSync(require.resolve('zustand/vanilla',{paths:[app]}),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return {sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),vanillaSha256:crypto.createHash('sha256').update(vanilla).digest('hex'),expression:`(()=>{const vanillaExports={};((exports)=>{${vanilla}\n})(vanillaExports);const result={};((exports,require)=>{${compiled}\n})(result,name=>{if(name==='zustand')return {create:vanillaExports.createStore};if(name==='@tauri-apps/api/core')return {invoke:(command,args)=>{if(!['get_clipboard_records','get_image_thumbnail','get_image_base64'].includes(command))throw Error('Reference forbids non-read command');return window.__TAURI_INTERNALS__.invoke(command,args)}};if(name==='@tauri-apps/api/event')return {listen:()=>{throw Error('Reference listeners excluded')}};throw Error('Unexpected reference dependency')});return result.useClipboardStore;})()`};
};
