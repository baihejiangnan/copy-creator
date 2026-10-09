// Build an isolated format-only frontend; original app fonts/CSS remain untouched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from '../copy-creator/node_modules/vite/dist/node/index.js';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),app=path.join(repo,'copy-creator');
const experiment=path.join(repo,'output/optimization/font-woff2-standard-20261008'),qa=path.join(repo,'output/optimization/QA-notes-20261007');
const control=process.argv.includes('--control');
const candidateRoot=path.join(experiment,control?'source-control':'source-candidate'),publicDir=path.join(candidateRoot,'public'),outDir=path.join(qa,control?'frontend-font-control':'frontend-font-woff2-complete');
if(fs.existsSync(candidateRoot)||fs.existsSync(outDir))throw Error('Refusing to overwrite a preserved candidate');
const report=JSON.parse(fs.readFileSync(path.join(experiment,'report.json'),'utf8'));if(!report.passed||report.fonts.length!==5)throw Error('Full font validation required');
fs.mkdirSync(path.join(publicDir,'字体'),{recursive:true});
for(const entry of fs.readdirSync(path.join(app,'public'),{withFileTypes:true}))if(entry.name!=='字体')fs.cpSync(path.join(app,'public',entry.name),path.join(publicDir,entry.name),{recursive:true,errorOnExist:true,force:false});
for(const font of report.fonts){const name=control?font.name:path.parse(font.name).name+'.woff2',file=control?path.join(app,'public/字体',name):path.join(experiment,name);if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==(control?font.sourceSha256:font.woff2Sha256))throw Error('Candidate font changed');fs.copyFileSync(file,path.join(publicDir,'字体',name),fs.constants.COPYFILE_EXCL)}
fs.cpSync(path.join(app,'src'),path.join(candidateRoot,'src'),{recursive:true,errorOnExist:true,force:false});
for(const name of ['index.html','radial.html','package.json','tsconfig.json','tsconfig.app.json','tsconfig.node.json'])fs.copyFileSync(path.join(app,name),path.join(candidateRoot,name),fs.constants.COPYFILE_EXCL);
const cssFile=path.join(candidateRoot,'src/styles/base.css');let source=fs.readFileSync(cssFile,'utf8');
if(!control){for(const font of report.fonts){const original="url('/字体/"+font.name+"') format('"+(font.name.endsWith('.ttf')?'truetype':'opentype')+"')",replacement="url('/字体/"+path.parse(font.name).name+".woff2') format('woff2')";if(!source.includes(original))throw Error('Expected font source changed');source=source.replace(original,replacement)}fs.writeFileSync(cssFile,source)}
const packages=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8')).dependencies;
await build({root:candidateRoot,configFile:path.join(app,'vite.config.ts'),publicDir,resolve:{alias:Object.keys(packages).map(find=>({find,replacement:path.join(app,'node_modules',find).replaceAll('\\','/')}))},build:{outDir,manifest:true,emptyOutDir:false}});
const css=fs.readdirSync(path.join(outDir,'assets')).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join(outDir,'assets',name),'utf8')).join('\n');if(!control&&/\.(ttf|otf)/.test(css))throw Error('Candidate references an unavailable original font');
fs.writeFileSync(path.join(experiment,control?'control-build.json':'candidate-build-complete.json'),JSON.stringify({scope:'Format-only isolated source/public copy; current app CSS/public unchanged',control,outDir,publicDir,transformScriptSha256:crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')},null,2));
