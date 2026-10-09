// Compatibility helper for textarea baseline and the virtualized plain editor.
// Call only after the driver has checked the native QA storage identity.
module.exports=async function editorDriver(page) {
  await page.evaluate(async()=>{
    const resource=performance.getEntriesByType("resource").find(entry=>/\/notesWorkspace-[^/]+\.js$/.test(entry.name));
    if(!resource)throw new Error("Loaded QA notes workspace missing");
    const {useNotesWorkspace}=await import(resource.name);
    window.__qaReadNoteBody=()=>{const state=useNotesWorkspace.getState();return state.coordinator?.getSession(state.selectedId)?.draft.body;};
  });
  return {
    read:async field=>await field.evaluate(field=>field instanceof HTMLTextAreaElement?field.value:window.__qaReadNoteBody()),
    set:async(field,text)=>{
      if(await field.evaluate(field=>field instanceof HTMLTextAreaElement))await field.fill(text);
      else {await field.focus();await page.keyboard.press("Control+A");await page.keyboard.insertText(text);}
      await page.waitForFunction(text=>window.__qaReadNoteBody()===text,text);
    },
  };
};
