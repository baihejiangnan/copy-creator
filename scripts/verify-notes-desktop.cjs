// Optional desktop QA driver. Uses an existing Playwright installation and a
// running, isolated QA application. Never launches or edits the everyday app.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const expected = process.env.QA_STORAGE_ROOT;
  assert.ok(expected, "Set QA_STORAGE_ROOT to the isolated QA directory");
  const browser = await chromium.connectOverCDP(process.env.QA_CDP_URL || "http://127.0.0.1:9223", { timeout: 5000 });
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url() === "http://tauri.localhost/");
  assert.ok(page, "QA main WebView not found");
  page.setDefaultTimeout(4000);
  const actual = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_storage_path"));
  assert.equal(require('./qa-path.cjs')(actual), require('./qa-path.cjs')(expected), "Refusing to interact with a different data directory");
  const finish=(result)=>{
    const fs=require("node:fs");
    const qaRoot=path.resolve(__dirname,"../output/optimization/QA-notes-20261007");
    const metadata=JSON.parse(fs.readFileSync(path.join(qaRoot,"process.json"),"utf8").replace(/^\uFEFF/,""));
    assert.equal(String(metadata.debugPort),new URL(process.env.QA_CDP_URL||"http://127.0.0.1:9223").port,"QA artifact metadata does not match the connection");
    const reports=path.join(qaRoot,"reports");fs.mkdirSync(reports,{recursive:true});
    fs.writeFileSync(path.join(reports,`${process.argv[2]||"flow"}-${Date.now()}.json`),JSON.stringify({time:new Date().toISOString(),app:metadata,storageRoot:actual,result},null,2));
    console.log(JSON.stringify(result));
  };
  await page.locator(".sidebar-nav").getByRole("button", { name: "便签", exact: true }).click();
  if (process.argv[2] === "snapshot") {
    console.log(await page.locator(".notes-page").ariaSnapshot()); process.exit(0);
  }
  const title = `QA 往返 ${Date.now()}`;
  const notes = page.locator(".notes-page");
  const button = (name) => notes.getByRole("button", { name, exact: true });
  if (await button("返回").isVisible()) await button("返回").click();
  await button("新建便签").waitFor();
  const {read:readBody,set:setBody}=await require("./qa-note-editor.cjs")(page);
  const open = async () => { await notes.locator(".notes-row").filter({ hasText: title }).click(); };
  if(process.argv[2]==="editor") {
    const raw="  中文😀\r\nnext\rlast  \n";
    const created=await page.evaluate(async({title,raw})=>{
      const epoch=await window.__TAURI_INTERNALS__.invoke("get_storage_epoch");
      const result=await window.__TAURI_INTERNALS__.invoke("create_note",{expectedStorageEpoch:epoch,id:crypto.randomUUID(),mutationId:crypto.randomUUID(),draft:{title,body:raw,refs:[]}});
      return {id:result.value.note.id,epoch};
    },{title,raw});
    await notes.getByRole("searchbox").fill(title);
    await open();
    const body=notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true});
    assert.equal(await readBody(body),raw);
    await body.focus();await page.keyboard.press("Control+End");await page.keyboard.insertText("追加");
    await page.waitForFunction(raw=>window.__qaReadNoteBody()===raw+"追加",raw);
    await page.keyboard.press("Control+z");await page.waitForFunction(raw=>window.__qaReadNoteBody()===raw,raw);
    await page.keyboard.press("Control+y");await page.waitForFunction(raw=>window.__qaReadNoteBody()===raw+"追加",raw);
    await page.keyboard.press("Control+Enter");await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
    const persisted=await page.evaluate(async({id,epoch})=>(await window.__TAURI_INTERNALS__.invoke("get_note",{expectedStorageEpoch:epoch,id})).value,created);
    assert.equal(persisted.body,raw+"追加");
    const oversized="中".repeat(90000);
    await setBody(body,oversized);await button("立即保存").click();
    await notes.locator(".notes-save-status").filter({hasText:"保存失败"}).waitFor();
    assert.equal(await readBody(body),oversized,"Oversized UTF-8 draft must remain recoverable");
    // Chromium insertText normalizes inserted CR/CRLF to LF. Preservation of
    // the original native document was checked above by editing its end.
    const correction=raw.replace(/\r\n?/g,"\n")+"修正后  ";
    await setBody(body,correction);await button("立即保存").click();
    await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
    const corrected=await page.evaluate(async({id,epoch})=>(await window.__TAURI_INTERNALS__.invoke("get_note",{expectedStorageEpoch:epoch,id})).value,created);
    assert.equal(corrected.body,correction);
    await button("返回").click();
    const search=notes.getByRole("searchbox");
    await search.fill("中".repeat(257));
    await notes.getByRole("alert").filter({hasText:"搜索"}).waitFor();
    await search.fill(title);await notes.locator(".notes-row").filter({hasText:title}).waitFor();
    finish({passed:"native CRLF/lone-CR/Unicode/space preservation, undo/redo, Ctrl+Enter, oversized UTF-8 recovery and overlong search error",noteId:created.id});process.exit(0);
  }
  if (process.argv[2] === "visual") {
    const fs=require("node:fs");
    const artifacts=process.env.QA_ARTIFACT_DIR || path.resolve(__dirname,"../output/optimization/QA-notes-20261007/screenshots");
    fs.mkdirSync(artifacts,{recursive:true});
    await button("新建便签").click();await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).fill(title);
    await setBody(notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true}),"便签字体与最小窗口检查：\n中文，标点。English ABC abc 0123456789\n换行与空白  ");
    await button("立即保存").click();await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
    const metrics=[];
    const resize=async(width,height)=>{
      await page.evaluate(({width,height})=>window.__TAURI_INTERNALS__.invoke("plugin:window|set_size",{label:"main",value:{Logical:{width,height}}}),{width,height});
      await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});
    };
    const capture=async(name)=>{
      await page.evaluate(()=>document.fonts.ready);
      const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,overflow:document.documentElement.scrollWidth>innerWidth,font:getComputedStyle(document.querySelector(".notes-page")).fontFamily,actionsBottom:document.querySelector(".notes-actions")?.getBoundingClientRect().bottom,clippedSidebarControls:[...document.querySelectorAll(".sidebar button,.sidebar-logo")].filter(element=>{const rect=element.getBoundingClientRect();return rect.top < -1 || rect.bottom > innerHeight+1;}).map(element=>element.getAttribute("title")||element.getAttribute("alt"))}));
      assert.equal(geometry.overflow,false);
      assert.deepEqual(geometry.clippedSidebarControls,[]);
      if(geometry.actionsBottom!==undefined)assert.ok(geometry.actionsBottom<=geometry.height+1);
      await page.screenshot({path:path.join(artifacts,`${name}.png`)});metrics.push({name,...geometry});
    };
    try {
      await resize(440,420);await capture("notes-min-zh-light");
      await page.getByRole("button",{name:"暗色",exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");await capture("notes-min-zh-dark");
      await page.getByRole("button",{name:"设置",exact:true}).click();await page.getByRole("button",{name:"EN",exact:true}).click();
      await page.locator(".sidebar-nav").getByRole("button",{name:"Notes",exact:true}).click();
      await notes.getByRole("textbox",{name:"Title (optional)",exact:true}).waitFor();await capture("notes-min-en-dark");
      await notes.getByRole("button",{name:"Back",exact:true}).click();await capture("notes-list-min-en-dark");
    } catch(error) {console.error("VISUAL_FAILURE",error.message);throw error;} finally {
      await resize(520,600);
      const settings=page.getByRole("button",{name:/^(Settings|设置)$/,exact:true});
      await settings.click();await page.getByRole("button",{name:"ZH",exact:true}).click();
      await page.locator(".sidebar-nav").getByRole("button",{name:"便签",exact:true}).click();
      if(await page.getByRole("button",{name:"亮色",exact:true}).isVisible())await page.getByRole("button",{name:"亮色",exact:true}).click();
    }
    finish({passed:"native minimum window, Chinese/English and light/dark layout",metrics,scope:"actual native window at current OS scale; other Windows DPI scales pending"});process.exit(0);
  }
  if (process.argv[2] === "boundary") {
    await button("新建便签").click();
    await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).fill(title);
    await button("立即保存").click();
    await notes.locator(".notes-save-status").filter({hasText:"尚未保存"}).waitFor();
    await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("request_app_restart"));
    await page.locator(".lifecycle-error").filter({hasText:"请填写正文或添加引用"}).waitFor();
    assert.equal(await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).inputValue(),title);
    await page.locator(".lifecycle-error").getByRole("button").click();
    await button("放弃本机稿").click();await button("确认").click();await button("新建便签").waitFor();
    await page.evaluate(async ()=>{
      const resource=performance.getEntriesByType("resource").find(entry=>/\/notesWorkspace-[^/]+\.js$/.test(entry.name));
      if(!resource)throw new Error("Loaded workspace module missing");
      const {useNotesWorkspace}=await import(resource.name);const coordinator=useNotesWorkspace.getState().coordinator;
      if(typeof coordinator?.transport!=="function")throw new Error("Transport unavailable");
      window.__qaBudget={coordinator,original:coordinator.transport};
      coordinator.transport=()=>Promise.reject({code:"notes.databaseFailed"});
    });
    const titles=Array.from({length:4},(_,index)=>`${title} 故障稿 ${index+1}`);
    try {
      for(const draftTitle of titles) {
        await button("新建便签").click();await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).fill(draftTitle);
        await setBody(notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true}),`${draftTitle}\n失败后保留。  `);
        await button("立即保存").click();await notes.locator(".notes-save-status").filter({hasText:"保存失败"}).waitFor();
        await button("返回").click();await button("新建便签").waitFor();
      }
      await button("新建便签").click();
      await notes.getByRole("alert").filter({hasText:"已有 4 份待处理草稿"}).waitFor();
      assert.equal(await notes.locator('section[aria-label="本机恢复稿"] .notes-row').count(),4);
      await page.evaluate(()=>{window.__qaBudget.coordinator.transport=window.__qaBudget.original;});
      for(const draftTitle of titles) {
        await notes.locator('section[aria-label="本机恢复稿"] .notes-row').filter({hasText:draftTitle}).click();
        assert.equal(await readBody(notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true})),`${draftTitle}\n失败后保留。  `);
        await button("立即保存").click();await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
        await button("返回").click();await button("新建便签").waitFor();
      }
      assert.equal(await notes.locator('section[aria-label="本机恢复稿"]').count(),0);
      finish({passed:"native restart refused for title-only draft; four failed drafts retained; fifth rejected; all recovered and saved",drafts:4});
    } finally {await page.evaluate(()=>{window.__qaBudget.coordinator.transport=window.__qaBudget.original;delete window.__qaBudget;});}
    process.exit(0);
  }
  if (process.argv[2] === "reliability") {
    await page.evaluate(async () => {
      const resource=performance.getEntriesByType("resource").find((entry)=>/\/notesWorkspace-[^/]+\.js$/.test(entry.name));
      if(!resource) throw new Error("Loaded workspace module was not found");
      const {useNotesWorkspace}=await import(resource.name);
      const coordinator=useNotesWorkspace.getState().coordinator;
      if(typeof coordinator?.transport!=="function") throw new Error("QA transport instrumentation is unavailable");
      const original=coordinator.transport;
      window.__qaProtocol={original,coordinator,invoke:window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__),calls:[],dropped:false};
      coordinator.transport=async (request) => {
        window.__qaProtocol.calls.push(JSON.parse(JSON.stringify(request)));
        const result=await original(request);
        if(request.expectedRevision===null && !window.__qaProtocol.dropped) {window.__qaProtocol.dropped=true;throw new Error("QA lost acknowledgement after commit");}
        return result;
      };
    });
    try {
      await button("新建便签").click();
      await notes.getByRole("textbox",{name:"标题（可选）",exact:true}).fill(title);
      const body=notes.getByRole("textbox",{name:"写下需要留存的内容…",exact:true});
      await setBody(body,"已提交但确认丢失。  ");await page.keyboard.press("Control+Enter");
      await notes.locator(".notes-save-status").filter({hasText:"保存失败"}).waitFor();
      assert.equal(await readBody(body),"已提交但确认丢失。  ");
      await setBody(body,"保留最新的本机修改。\n第二行  ");await button("立即保存").click();
      await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
      const protocol=await page.evaluate(async () => {
        const state=window.__qaProtocol;
        const id=state.calls[0].id,epoch=state.calls[0].storageEpoch;
        const saved=await state.invoke("get_note",{expectedStorageEpoch:epoch,id});
        return {calls:state.calls,saved:saved.value,id,epoch};
      });
      assert.equal(protocol.calls.length,3);
      assert.deepEqual(protocol.calls[0],protocol.calls[1]);
      assert.equal(protocol.saved.body,"保留最新的本机修改。\n第二行  ");assert.equal(protocol.saved.revision,2);
      await page.evaluate(async ({id,epoch,revision}) => {
        await window.__qaProtocol.invoke("save_note",{expectedStorageEpoch:epoch,id,expectedRevision:revision,mutationId:crypto.randomUUID(),draft:{title:"QA 并发修改",body:"其他写入者的版本",refs:[]}});
      },{id:protocol.id,epoch:protocol.epoch,revision:protocol.saved.revision});
      await setBody(body,"发生冲突的本机稿仍需保留。  ");await button("立即保存").click();
      await notes.locator(".notes-save-status").filter({hasText:"版本冲突"}).waitFor();
      assert.equal(await readBody(body),"发生冲突的本机稿仍需保留。  ");
      await button("另存为新便签").click();await page.keyboard.press("Control+Enter");
      await notes.locator(".notes-save-status").filter({hasText:"已保存"}).waitFor();
      assert.equal(await readBody(body),"发生冲突的本机稿仍需保留。  ");
      const remote=await page.evaluate(async ({id,epoch}) => (await window.__qaProtocol.invoke("get_note",{expectedStorageEpoch:epoch,id})).value,{id:protocol.id,epoch:protocol.epoch});
      assert.equal(remote.body,"其他写入者的版本");assert.equal(remote.revision,3);
      finish({passed:"native lost acknowledgement retries identical request, drains newer edit, conflict keeps local draft and saves separate copy",originalId:protocol.id,originalRevision:remote.revision});
    } finally {await page.evaluate(() => {window.__qaProtocol.coordinator.transport=window.__qaProtocol.original;delete window.__qaProtocol;});}
    process.exit(0);
  }
  await button("新建便签").click();
  await notes.getByRole("textbox", { name: "标题（可选）", exact: true }).fill(title);
  const body = notes.getByRole("textbox", { name: "写下需要留存的内容…", exact: true });
  const text = "中文原生保存验收。\n换行、末尾空格保留。  ";
  await setBody(body,text); await page.keyboard.press("Control+Enter");
  await notes.locator(".notes-save-status").filter({ hasText: "已保存" }).waitFor();
  assert.equal(await readBody(body), text);
  await button("添加链接").click(); await notes.getByRole("textbox", { name: "链接地址", exact: true }).fill("https://example.com/notes?q=%E4%B8%AD%E6%96%87");
  await notes.locator("form").getByRole("button", { name: "添加链接", exact: true }).click();
  await button("立即保存").click(); await notes.locator(".notes-save-status").filter({ hasText: "已保存" }).waitFor();
  await button("归档").click(); await button("新建便签").waitFor(); await button("归档").click(); await open();
  await button("取消归档").click(); await button("新建便签").waitFor(); await button("便签").click(); await open();
  await button("删除").click(); await notes.locator(".notes-confirm").waitFor(); await button("确认").click();
  await button("新建便签").waitFor(); await button("回收站").click(); await open();
  assert.equal(await body.evaluate(field=>field instanceof HTMLTextAreaElement?field.readOnly:field.getAttribute("contenteditable")==="false"&&field.getAttribute("aria-readonly")==="true"),true);
  await button("恢复").click(); await button("新建便签").waitFor(); await button("便签").click(); await open();
  assert.equal(await readBody(body), text);
  assert.equal(await notes.locator(".notes-reference").count(), 1);
  finish({ passed: "native notes create/save/link/archive/unarchive/delete/restore", title, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
  // Disconnect the driver without sending Browser.close to the owned WebView.
  process.exit(0);
})().catch((error) => { console.error(error.stack); process.exit(1); });
