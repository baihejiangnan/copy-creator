// Temporary DOM/style probes in an explicitly isolated QA WebView. These
// measurements select a candidate; they are not production acceptance results.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
(async()=>{
  assert.ok(process.env.QA_STORAGE_ROOT);
  const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL,{timeout:5000});
  const page=browser.contexts()[0].pages().find(page=>page.url()==="http://tauri.localhost/");
  const actual=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("get_storage_path"));
  assert.equal(path.resolve(actual).toLowerCase(),path.resolve(process.env.QA_STORAGE_ROOT).toLowerCase());
  const field=page.locator(".notes-body");await field.waitFor();
  const initial=await field.evaluate(field=>({style:field.getAttribute("style"),wrap:field.getAttribute("wrap"),spellcheck:field.getAttribute("spellcheck")}));
  const scenarios=[{name:"unchanged",style:{}},{name:"spellcheck-off",spellcheck:false,style:{}},{name:"break-all",style:{wordBreak:"break-all"}},
    {name:"no-kerning-ligatures",style:{fontKerning:"none",fontVariantLigatures:"none"}},
    {name:"wrap-off",wrap:"off",style:{whiteSpace:"pre",overflowWrap:"normal"}},
    {name:"paragraphs",style:{}}];
  const results=[];
  const destination=path.resolve(__dirname,`../output/optimization/QA-notes-20261007/layout-probes-${Date.now()}.json`);
  try {
    for(const scenario of scenarios) {
      await page.evaluate(({initial,scenario})=>{
        const field=document.querySelector(".notes-body");if(!field)throw new Error("QA editor missing");
        for(const name of ["style","wrap","spellcheck"]) {if(initial[name]===null)field.removeAttribute(name);else field.setAttribute(name,initial[name]);}
        Object.assign(field.style,scenario.style);if(scenario.wrap)field.wrap=scenario.wrap;if(scenario.spellcheck!==undefined)field.spellcheck=scenario.spellcheck;
      },{initial,scenario});
      const text=scenario.name==="paragraphs"?"中文 Mixed ABC 0123\n".repeat(10200):"中A".repeat(65000);
      await field.fill(text);await field.press("Control+End");
      const session=await page.context().newCDPSession(page);
      const finished=new Promise(resolve=>session.once("Tracing.tracingComplete",resolve));
      await session.send("Tracing.start",{categories:"devtools.timeline",transferMode:"ReturnAsStream"});
      await page.keyboard.type("abcde",{delay:100});
      await session.send("Tracing.end");const{stream}=await finished;let trace="";
      for(;;){const chunk=await session.send("IO.read",{handle:stream});trace+=chunk.data;if(chunk.eof)break;}
      await session.send("IO.close",{handle:stream});await session.detach();
      const events=JSON.parse(trace).traceEvents;
      results.push({scenario:scenario.name,keypress_ms:events.filter(e=>e.name==="EventDispatch"&&e.args?.data?.type==="keypress"&&e.ph==="X").map(e=>e.dur/1000),layout_ms:events.filter(e=>e.name==="Layout"&&e.ph==="X").map(e=>e.dur/1000)});
      fs.writeFileSync(destination,JSON.stringify({scope:"runtime style probes only; five native dispatched characters per case, not an acceptance sample",results},null,2));
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    await page.evaluate(initial=>{const field=document.querySelector(".notes-body");if(!field)return;for(const name of ["style","wrap","spellcheck"]) {if(initial[name]===null)field.removeAttribute(name);else field.setAttribute(name,initial[name]);}},initial);
    await page.getByRole("button",{name:"立即保存",exact:true}).click();
  }
  fs.writeFileSync(destination,JSON.stringify({scope:"runtime style probes only; five native dispatched characters per case, not an acceptance sample",results},null,2));
  console.log(JSON.stringify({destination,results}));process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
