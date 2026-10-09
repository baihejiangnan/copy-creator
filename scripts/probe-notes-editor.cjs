// Experimental editor only, mounted over an isolated QA app and removed in
// finally. It does not write the candidate document into the application DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  assert.ok(process.env.QA_STORAGE_ROOT);
  const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL,{timeout:5000});
  const page=browser.contexts()[0].pages().find(page=>page.url()==='http://tauri.localhost/');
  const actual=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));
  assert.equal(path.resolve(actual).toLowerCase(),path.resolve(process.env.QA_STORAGE_ROOT).toLowerCase());
  const root=path.resolve(__dirname,'../output/optimization/editor-probe-20261007');
  const session=await page.context().newCDPSession(page);
  const code=fs.readFileSync(path.join(root,'dist/probe.js'),'utf8');
  const injected=await session.send('Runtime.evaluate',{expression:code,allowUnsafeEvalBlockedByCSP:true});
  assert.ok(!injected.exceptionDetails,'Failed to inject local QA editor probe');
  const results=[];
  try {
    for(const scenario of ['single-paragraph','many-paragraphs']) {
      const doc=scenario==='single-paragraph'?'中A'.repeat(65506):'中文 Mixed ABC 0123\n'.repeat(10000);
      await page.evaluate(doc=>window.__qaMountEditor(doc),doc);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const completed=new Promise(resolve=>session.once('Tracing.tracingComplete',resolve));
      await session.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing',transferMode:'ReturnAsStream'});
      await page.keyboard.type('a'.repeat(110),{delay:70});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await session.send('Tracing.end');const{stream}=await completed;let trace='';
      for(;;){const chunk=await session.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof)break;}
      await session.send('IO.close',{handle:stream});
      const events=JSON.parse(trace).traceEvents;
      const keys=events.filter(e=>e.name==='EventDispatch'&&e.args?.data?.type==='keydown'&&e.ph==='X');
      const paints=events.filter(e=>e.name==='Paint'&&e.ph==='X');
      const latency=keys.map((key,index)=>{const end=keys[index+1]?.ts||Infinity;const paint=paints.find(p=>p.pid===key.pid&&p.tid===key.tid&&p.ts>=key.ts&&p.ts<end);return paint?{index,ms:(paint.ts+paint.dur-key.ts)/1000}:null;}).filter(Boolean);
      const integrity=await page.evaluate(expected=>{const view=window.__qaProbeView;return{exact:view.state.doc.toString()===expected,length:view.state.doc.length,visibleCharacters:view.visibleRanges.reduce((n,r)=>n+r.to-r.from,0),font:getComputedStyle(view.contentDOM).fontFamily};},doc+'a'.repeat(110));
      assert.equal(integrity.exact,true);assert.equal(keys.length,110);assert.equal(latency.length,110);
      const samples=latency.slice(10).map(x=>x.ms).sort((a,b)=>a-b);
      const longTasks=events.filter(e=>e.ph==='X'&&(e.name==='EventDispatch'||e.name==='Layout'||e.name==='FunctionCall')&&e.dur>50000).map(e=>({name:e.name,type:e.args?.data?.type,ms:e.dur/1000}));
      const tracePath=path.join(root,`trace-${scenario}-${Date.now()}.json`);fs.writeFileSync(tracePath,trace);
      results.push({scenario,integrity,keyToPaint:{samples:samples.length,p50_ms:samples[49],p95_ms:samples[94],max_ms:samples.at(-1)},longTasks,tracePath});
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {await page.evaluate(()=>window.__qaRemoveEditor?.());}
  fs.writeFileSync(path.join(root,`results-${Date.now()}.json`),JSON.stringify({scope:'Experimental DOM editor, same actual QA WebView/fonts; full document retained; 110 CDP keystrokes/scenario, first 10 excluded; not application integration/IME/persistence acceptance',bundleBytes:Buffer.byteLength(code),results},null,2));
  process.exit(0);
})().catch(error=>{console.error(String(error.message).split('Call log:')[0]);process.exit(1);});
