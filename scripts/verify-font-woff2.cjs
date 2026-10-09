// Compare exact full fonts in actual QA WebView2; CDP supplies only these local font buffers.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=path.resolve(__dirname,'..'),root=path.join(repo,'output/optimization/QA-notes-20261007'),experiment=path.join(repo,'output/optimization/font-woff2-standard-20261008'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const fonts=JSON.parse(fs.readFileSync(path.join(experiment,'report.json'),'utf8'));assert.equal(fonts.passed,true);
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await p.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=p;break}if(page)break;await wait(100)}assert.ok(page);
 const report={started:new Date().toISOString(),app:info,scope:'Actual WebView2 FontFace constructor plus load, representative raster and width comparison at actual DPR. Full glyph/table coverage separately verified in Python. Buffer decode timing excludes disk/network and is not app startup or Windows DPI visual acceptance.',fonts:[]},destination=path.join(root,'reports','font-woff2-'+Date.now()+'.json');
 try{
  for(let index=0;index<fonts.fonts.length;index++){
   const font=fonts.fonts[index],buffers=[fs.readFileSync(path.join(repo,'copy-creator/public/字体',font.name)),fs.readFileSync(path.join(experiment,path.parse(font.name).name+'.woff2'))];assert.equal(crypto.createHash('sha256').update(buffers[0]).digest('hex'),font.sourceSha256);assert.equal(crypto.createHash('sha256').update(buffers[1]).digest('hex'),font.woff2Sha256);
   const result=await page.evaluate(async({encoded,index})=>{
    const corpus=['简体中文 繁體中文 便签資料密碼箱，。！？《》「」','𠮷𠀀䶮龘靐麤 你好 世界 㐀㐁㐂','ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz','0123456789 !@#$%^&*()[]{}<> /\\ |+-= _~:;\'"','const result = await save("正文\\r\\n  "); // preserves raw text','https://example.invalid/long/path?query=中文&value=123','C:\\很长的文件夹名称\\项目资料 long name, 测试.txt','emoji: 😀 🧑‍💻 ❤️ 🇨🇳 ✨ → ← ↑ ↓ ≥ ≤ ≠ ∑ √ Ω α é Å'];
    const buffers=encoded.map(value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0)).buffer);
    const faces=[],times=[[],[]];
    for(let sample=0;sample<30;sample++)for(const variant of (sample%2?[1,0]:[0,1])){const start=performance.now();const face=new FontFace('QAFont'+index+'_'+variant+'_'+sample,buffers[variant]);await face.load();times[variant].push(performance.now()-start);if(sample===0){document.fonts.add(face);faces[variant]=face}}
    let rasterComparisons=0,widthComparisons=0,pixelDifferences=0,widthDifferences=0;
    const canvas=document.createElement('canvas'),dpr=devicePixelRatio;canvas.width=Math.ceil(1000*dpr);canvas.height=Math.ceil(70*dpr);const ctx=canvas.getContext('2d',{willReadFrequently:true});
    for(const size of [12,14,16,20,24,32])for(const dark of [false,true])for(const text of corpus){const pixels=[],widths=[];for(let variant=0;variant<2;variant++){ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=dark?'#121212':'#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=dark?'#eeeeee':'#121212';ctx.font=size+'px "'+faces[variant].family+'"';widths.push(ctx.measureText(text).width);ctx.fillText(text,8,45);pixels.push(ctx.getImageData(0,0,canvas.width,canvas.height).data)}widthComparisons++;if(widths[0]!==widths[1])widthDifferences++;rasterComparisons++;for(let p=0;p<pixels[0].length;p++)if(pixels[0][p]!==pixels[1][p])pixelDifferences++}
    faces.forEach(face=>document.fonts.delete(face));const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p50:sorted[14],p95:sorted[28],max:sorted[29]}};
    return {dpr,rasterComparisons,widthComparisons,pixelDifferences,widthDifferences,originalDecodeMs:summary(times[0]),woff2DecodeMs:summary(times[1])};
   },{encoded:buffers.map(buffer=>buffer.toString('base64')),index});
   assert.equal(result.pixelDifferences,0);assert.equal(result.widthDifferences,0);report.fonts.push({name:fonts.fonts[index].name,...result});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify(report.fonts.at(-1)));
  }
  report.passed=true;
 }catch(error){report.error=error.message;throw error}
 finally{report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
