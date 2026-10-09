// Native IPC/performance verification against an explicitly isolated QA app.
// Uses only synthetic fixtures; does not read content from other records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "../output/optimization/QA-notes-20261007");
const distribution = values => {
  const sorted = [...values].sort((a,b)=>a-b);
  const at = p => sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {samples:sorted.length,p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)};
};
(async()=>{
  assert.ok(process.env.QA_STORAGE_ROOT,"QA_STORAGE_ROOT is required");
  const metadata = JSON.parse(fs.readFileSync(path.join(root,"process.json"),"utf8").replace(/^\uFEFF/,""));
  const cdp = process.env.QA_CDP_URL;
  assert.equal(String(metadata.debugPort),new URL(cdp).port);
  const browser = await chromium.connectOverCDP(cdp,{timeout:5000});
  const page = browser.contexts()[0].pages().find(page=>page.url()==="http://tauri.localhost/");
  assert.ok(page,"QA main WebView not found");
  const storage = await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("get_storage_path"));
  assert.equal(require('./qa-path.cjs')(storage),require('./qa-path.cjs')(process.env.QA_STORAGE_ROOT),"Refusing non-QA storage");
  const fixturePath = path.join(root,"performance-fixture.json");
  let fixture;
  if(fs.existsSync(fixturePath)) fixture=JSON.parse(fs.readFileSync(fixturePath,"utf8"));
  else {
    fixture={prefix:"QAPerf%_",records:Array.from({length:2000},(_,index)=>({id:randomUUID(),mutationId:randomUUID(),draft:{title:`QAPerf%_ ${index}`,body:("中文 Mixed ABC 0123\nhttps://example.com/\nconst n = 1;  \n").repeat(16+index%48),refs:[]}}))};
    fs.writeFileSync(fixturePath,JSON.stringify(fixture));
  }
  const epoch=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("get_storage_epoch"));
  const started=new Date().toISOString();
  const mode=process.argv[2]||"stress";
  let result;
  if(mode==="seed") {
    result=await page.evaluate(async({fixture,epoch})=>{
      const invoke=window.__TAURI_INTERNALS__.invoke;
      let created=0;
      // Sequential admission keeps queue pressure out of fixture preparation;
      // immutable IDs/requests make an interrupted seed safe to repeat.
      for(const record of fixture.records) {
        await invoke("create_note",{expectedStorageEpoch:epoch,...record});created++;
      }
      return {created};
    },{fixture,epoch});
  } else if(mode==="input") {
    await page.locator(".sidebar-nav").getByRole("button",{name:"便签",exact:true}).click();
    const notes=page.locator(".notes-page");
    if(await notes.getByRole("button",{name:"返回",exact:true}).isVisible())await notes.getByRole("button",{name:"返回",exact:true}).click();
    await notes.getByRole("button",{name:"新建便签",exact:true}).click();
    const {set:setBody}=await require("./qa-note-editor.cjs")(page);
    await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).fill(`QAPerfInput ${Date.now()}`);
    const body=notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true});
    const cdpSession=await page.context().newCDPSession(page);
    const traceFinished=new Promise(resolve=>cdpSession.once("Tracing.tracingComplete",resolve));
    await cdpSession.send("Tracing.start",{categories:"devtools.timeline,blink.user_timing",transferMode:"ReturnAsStream"});
    const measurements=[];
    try {
      for(const scenario of ["ordinary","boundary256k"]) {
        const base=scenario==="ordinary"?"普通输入测试。\n".repeat(100):"中文 Mixed abc\n".repeat(14000).slice(0,190000);
        // Exact UTF-8 limit, with room for all native keyboard insertions.
        const sized=scenario==="ordinary"?base:"中A".repeat(65506); // 262024 bytes
        await setBody(body,sized);await body.focus();await body.press("Control+End");
        await page.evaluate(scenario=>{
          const field=document.querySelector(".notes-body-editor .cm-content,.notes-body");
          window.__qaInput={scenario,samples:[],count:0,keyCount:0,longTasks:[]};
          window.__qaInput.observer=new PerformanceObserver(list=>window.__qaInput.longTasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration}))));
          window.__qaInput.observer.observe({type:"longtask",buffered:false});
          window.__qaInput.listener=()=>{
            const state=window.__qaInput,index=state.count++,started=performance.now();
            performance.mark(`qa-input-${state.scenario}-${index}`);
            requestAnimationFrame(()=>state.samples.push({index,toAnimationFrame_ms:performance.now()-started}));
          };
          field.addEventListener("input",window.__qaInput.listener,true);
          window.__qaInput.keyListener=()=>performance.mark(`qa-key-${scenario}-${window.__qaInput.keyCount++}`);
          field.addEventListener("keydown",window.__qaInput.keyListener,true);
        },scenario);
        await page.keyboard.type("a".repeat(110),{delay:70});
        await page.waitForFunction(()=>window.__qaInput.samples.length===110);
        const captured=await page.evaluate(()=>{
          const state=window.__qaInput,field=document.querySelector(".notes-body-editor .cm-content,.notes-body");
          field.removeEventListener("input",state.listener,true);state.observer.disconnect();
          field.removeEventListener("keydown",state.keyListener,true);
          const result={scenario:state.scenario,samples:state.samples,longTasks:state.longTasks,bodyBytes:new TextEncoder().encode(window.__qaReadNoteBody()).byteLength};
          delete window.__qaInput;return result;
        });
        measurements.push(captured);
      }
      await notes.getByRole("button",{name:"立即保存",exact:true}).click();
      await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
    } finally { await cdpSession.send("Tracing.end"); }
    const {stream}=await traceFinished;
    let trace="";
    for(;;) {const chunk=await cdpSession.send("IO.read",{handle:stream});trace+=chunk.base64Encoded?Buffer.from(chunk.data,"base64").toString("utf8"):chunk.data;if(chunk.eof)break;}
    await cdpSession.send("IO.close",{handle:stream});
    const events=JSON.parse(trace).traceEvents;
    const tracePath=path.join(root,`input-trace-${Date.now()}.json`);fs.writeFileSync(tracePath,trace);
    result={measurements:measurements.map(measurement=>{
      const marks=events.filter(event=>event.name.startsWith(`qa-input-${measurement.scenario}-`)&&event.ph==="I").sort((a,b)=>a.ts-b.ts);
      const paints=events.filter(event=>event.name==="Paint"&&event.ph==="X");
      const keys=events.filter(event=>event.name.startsWith(`qa-key-${measurement.scenario}-`)&&event.ph==="I").sort((a,b)=>a.ts-b.ts);
      const keyPaint=keys.map((key,index)=>{const next=keys[index+1]?.ts||Infinity;const paint=paints.find(event=>event.pid===key.pid&&event.tid===key.tid&&event.ts>=key.ts&&event.ts<next);return paint?{index,ms:(paint.ts+(paint.dur||0)-key.ts)/1000}:null;}).filter(Boolean);
      const painted=marks.map((mark,index)=>{
        const next=marks[index+1]?.ts||Infinity;
        const paint=paints.find(event=>event.pid===mark.pid&&event.tid===mark.tid&&event.ts>=mark.ts&&event.ts<next);
        return paint?{index,ms:(paint.ts+(paint.dur||0)-mark.ts)/1000}:null;
      }).filter(Boolean);
      assert.equal(keyPaint.length,110,"Every key must have a corresponding Paint");
      return {...measurement,animationFrame:distribution(measurement.samples.slice(10).map(sample=>sample.toAnimationFrame_ms)),paint:painted.length?distribution(painted.filter(sample=>sample.index>=10).map(sample=>sample.ms)):null,paintSamples:painted.length,keyToPaint:distribution(keyPaint.filter(sample=>sample.index>=10).map(sample=>sample.ms))};
    }),tracePath,scope:"Actual Release WebView editor; CDP keyboard dispatch, not physical keyboard/Windows IME. 110 paced keystrokes/scenario, first 10 excluded. Keydown capture and input capture to subsequent renderer Paint end reported separately. Animation-frame time is not paint. Does not count synthetic composition as real IME acceptance."};
  } else if(mode==="stress") {
    const metricLog=process.env.QA_METRICS_LOG;
    if(metricLog)assert.ok(path.resolve(metricLog).toLowerCase().includes("com.copycreator.qa20261007"),"Metric log must belong to QA identifier");
    const logOffset=metricLog&&fs.existsSync(metricLog)?fs.statSync(metricLog).size:0;
    const raw=await page.evaluate(async({fixture,epoch})=>{
      const invoke=window.__TAURI_INTERNALS__.invoke;
      const samples={list:[],searchAbsent:[],searchLiteral:[],get:[],save:[],mixedSave:[],mixedRead:[]};
      let busy=0,maxListBytes=0;
      const timing=async(name,command,args)=>{
        const start=performance.now();let value;
        for(let attempt=0;;attempt++) {
          try {value=await invoke(command,{expectedStorageEpoch:epoch,...args});break;}
          catch(error) {if(error?.code!=="notes.busy"||attempt>=30)throw error;busy++;await new Promise(resolve=>setTimeout(resolve,10));}
        }
        samples[name].push(performance.now()-start);return value.value;
      };
      const record=fixture.records[0];
      let current=(await invoke("get_note",{expectedStorageEpoch:epoch,id:record.id})).value;
      for(let index=0;index<110;index++) {
        const list=await timing("list","list_notes",{filter:"active",search:"",cursor:null,limit:50});
        if(list.records.some(record=>Object.hasOwn(record,"body")))throw new Error("List leaked body");
        maxListBytes=Math.max(maxListBytes,new TextEncoder().encode(JSON.stringify(list)).byteLength);
        const absent=await timing("searchAbsent","list_notes",{filter:"active",search:"QAPerf-absent-token",cursor:null,limit:50});
        if(absent.records.length!==0)throw new Error("Absent search matched");
        const literal=await timing("searchLiteral","list_notes",{filter:"active",search:fixture.prefix,cursor:null,limit:50});
        if(literal.records.length!==50||literal.records.some(record=>!record.title.startsWith(fixture.prefix)))throw new Error("Literal search mismatch");
        await timing("get","get_note",{id:record.id});
        current=(await timing("save","save_note",{id:record.id,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...record.draft,body:record.draft.body+`\n${index}`}})).note;
      }
      for(let index=0;index<110;index++) {
        // Search/get churn alongside one single-flight save. Busy retries count
        // towards end-to-end latency, rather than disappearing from samples.
        const reads=Array.from({length:8},(_,i)=>timing("mixedRead",i%2?"get_note":"list_notes",i%2?{id:record.id}:{filter:"active",search:i%4?fixture.prefix:"QAPerf-absent-token",cursor:null,limit:50}));
        const write=timing("mixedSave","save_note",{id:record.id,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...record.draft,body:record.draft.body+`\nmixed ${index}`}});
        const [saved]=await Promise.all([write,...reads]);current=saved.note;
      }
      const seen=new Set();let cursor=null,pages=0;
      do {
        const page=(await invoke("list_notes",{expectedStorageEpoch:epoch,filter:"active",search:fixture.prefix,cursor,limit:50})).value;
        for(const record of page.records) {if(seen.has(record.id))throw new Error("Duplicate cursor record");seen.add(record.id);}
        cursor=page.next_cursor;pages++;
      } while(cursor);
      if(seen.size!==fixture.records.length||fixture.records.some(record=>!seen.has(record.id)))throw new Error("Cursor skipped a fixture record");
      return {samples,busy,maxListBytes,pages,records:seen.size,finalRevision:current.revision};
    },{fixture,epoch});
    assert.ok(raw.maxListBytes<=64*1024,"Summary payload exceeds 64 KiB");
    const latency=Object.fromEntries(Object.entries(raw.samples).map(([name,values])=>[name,distribution(values.slice(name==="mixedRead"?80:10))]));
    let native=[];
    if(metricLog) {
      assert.ok(path.resolve(metricLog).toLowerCase().includes("com.copycreator.qa20261007"),"Metric log must belong to QA identifier");
      native=fs.readFileSync(metricLog,"utf8").slice(logOffset).split(/\r?\n/).flatMap(line=>{
        const match=/notes operation=(\w+) write=(true|false) ok=(true|false) queued_us=(\d+) lock_wait_us=(\d+) held_us=(\d+) sql_count=(\d+) sql_profile_ms=(\d+)/.exec(line);
        return match?[{operation:match[1],write:match[2]==="true",ok:match[3]==="true",queued_us:+match[4],lock_wait_us:+match[5],held_us:+match[6],sql_count:+match[7],sql_profile_ms:+match[8]}]:[];
      });
      assert.ok(native.length>100,"Diagnostics build produced no usable DB metrics");
    }
    const {samples,...details}=raw;
    result={...details,latency,nativeSummary:Object.fromEntries([...new Set(native.map(row=>row.operation))].map(operation=>{
      const rows=native.filter(row=>row.operation===operation);
      return [operation,{samples:rows.length,...Object.fromEntries(["queued_us","lock_wait_us","held_us","sql_profile_ms"].map(key=>[key,distribution(rows.map(row=>row[key]/(key.endsWith("_us")?1000:1)))])),sqlStatements:[Math.min(...rows.map(row=>row.sql_count)),Math.max(...rows.map(row=>row.sql_count))]}];
    })),native,scope:"Native IPC timings include serialization/bridge/retry; 10 warmups excluded, mixed reads exclude first 80. SQLite profile duration is coarse millisecond resolution; held/queue/lock use monotonic microseconds. Does not replace input-to-paint or full application baseline."};
  } else throw new Error(`Unknown mode ${mode}`);
  const reports=path.join(root,"reports");fs.mkdirSync(reports,{recursive:true});
  const destination=path.join(reports,`performance-${mode}-${Date.now()}.json`);
  fs.writeFileSync(destination,JSON.stringify({started,finished:new Date().toISOString(),app:metadata,storageRoot:storage,fixture:{notes:fixture.records.length,prefix:fixture.prefix},result},null,2));
  console.log(JSON.stringify({report:destination,...result,native:undefined}));
  process.exit(0); // disconnect the driver; never Browser.close the QA WebView
})().catch(error=>{console.error(error);process.exit(1);});
