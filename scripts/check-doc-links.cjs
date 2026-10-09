// Local Markdown navigation/anchors and unique authoritative TODO identifiers.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=execFileSync('rg',['--files','docs','-g','*.md'],{cwd:root,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).concat(['AGENTS.md','README.md','README_EN.md','copy-creator/README.md']);
const errors=[],cache=new Map();let links=0;
const text=file=>{if(!cache.has(file))cache.set(file,fs.readFileSync(file,'utf8').replace(/```[^\n]*\n[\s\S]*?```/g,''));return cache.get(file)};
const anchors=file=>{
 const seen=new Map(),result=new Set();
 for(const match of text(file).matchAll(/^#{1,6}\s+(.+)$/gm)){
  const slug=match[1].trim().replace(/\s+#+\s*$/,'').replace(/<[^>]*>/g,'').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s/g,'-');
  const count=seen.get(slug)||0;result.add(count?`${slug}-${count}`:slug);seen.set(slug,count+1);
 }
 return result;
};
for(const relative of files){
 const file=path.join(root,relative);
 for(const match of text(file).matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)){
  const target=match[1].replace(/^<|>$/g,'');if(/^(?:https?:|mailto:|app:|codex:|plugin:|data:)/i.test(target))continue;
  links++;const [location,anchor]=target.split('#');const resolved=location?path.resolve(path.dirname(file),decodeURIComponent(location)):file;
  if(!fs.existsSync(resolved))errors.push(`${relative}: missing ${target}`);
  else if(anchor&&/\.md$/i.test(resolved)&&!anchors(resolved).has(decodeURIComponent(anchor)))errors.push(`${relative}: missing anchor ${target}`);
 }
}
const ids=[...text(path.join(root,'docs/TODO.md')).matchAll(/^- \[[ x]\] \*\*([SNO]-\d{2})\b/gm)].map(match=>match[1]);
if(ids.length!==new Set(ids).size)errors.push('Duplicate TODO task identifiers');
console.log(JSON.stringify({documents:files.length,localLinks:links,todoIdentifiers:ids.length,errors},null,2));if(errors.length)process.exitCode=1;
