// Read-only frontend inventory and Vite manifest dependency closure report.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const zlib=require("node:zlib");
const root=path.resolve(process.argv[2]||"copy-creator/dist");
function walk(directory,prefix="") {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()
    ? walk(path.join(directory,entry.name),`${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}
const files=walk(root).filter(file=>!file.startsWith(".vite/"));
const inventory=files.map(file=>{
  const bytes=fs.readFileSync(path.join(root,file));
  return {file,bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),
    ...(/\.(js|css)$/.test(file)?{gzipBytes:zlib.gzipSync(bytes).length}:{})};
});
const describe=selected=>({files:selected.length,bytes:selected.reduce((sum,file)=>sum+file.bytes,0),gzipBytes:selected.reduce((sum,file)=>sum+(file.gzipBytes||0),0)});
const manifestPath=path.join(root,".vite/manifest.json");
const entries={};
if(fs.existsSync(manifestPath)) {
  const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
  function closure(key) {
    const seen=new Set(),resources=new Set();
    function visit(name) {
      if(seen.has(name))return;seen.add(name);
      const chunk=manifest[name];if(!chunk)throw new Error(`Missing manifest dependency ${name}`);
      resources.add(chunk.file);for(const css of chunk.css||[])resources.add(css);
      for(const imported of chunk.imports||[])visit(imported);
    }
    visit(key);return resources;
  }
  for(const [key,entry]of Object.entries(manifest).filter(([,entry])=>entry.isEntry)) {
    const resources=closure(key),selected=inventory.filter(file=>resources.has(file.file));
    entries[key]={entry:entry.file,staticJavaScript:describe(selected.filter(file=>file.file.endsWith(".js"))),
      staticCss:describe(selected.filter(file=>file.file.endsWith(".css"))),resources:[...resources].sort()};
  }
}
const report={root,scope:"raw published files excluding optional .vite analysis metadata; gzip sums compress files separately; manifest closures exclude dynamic imports and public font/image network loading",total:{files:inventory.length,bytes:inventory.reduce((sum,file)=>sum+file.bytes,0)},
  allJavaScript:describe(inventory.filter(file=>file.file.endsWith(".js"))),allCss:describe(inventory.filter(file=>file.file.endsWith(".css"))),
  fonts:describe(inventory.filter(file=>/\.(ttf|otf|woff2?)$/i.test(file.file))),entries,inventory};
const output=process.argv[3];if(output)fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,inventory:undefined},null,2));
