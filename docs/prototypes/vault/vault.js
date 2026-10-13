/* All data and actions are synthetic. No storage, clipboard, network or Tauri API. */
"use strict";
const words = {
    ...identityWords,
    skip: ["跳到保险箱", "Skip to vault"],
    vault: ["保险箱", "Vault"], prototype: ["保险箱交互原型", "Vault interactive prototype"], reset: ["重置示例", "Reset examples"], dark: ["深色", "Dark"], light: ["浅色", "Light"], locked: ["已锁定", "Locked"], unlocked: ["已解锁", "Unlocked"], lock: ["锁定保险箱", "Lock vault"], unlock: ["解锁示例保险箱", "Unlock demo vault"], gateTitle: ["你的资料，单独保管", "Your details, kept together"], gateBody: ["账号、服务器和私密文字，都放在保险箱里。", "Keep accounts, servers and private text in your vault."], gateNote: ["原型无需主密码；正式应用沿用主密码保护。", "No password needed in this prototype. The app retains master password protection."], tryEyebrow: ["试一试", "Try it"], tryTitle: ["把字段放到正确的位置", "Put each field in the right place"], tryIntro: ["先点击下方输入框，再点击左侧条目中的字段值。这里模拟你正在使用的另一个应用。", "Select an input below, then click a field value in the vault. This simulates the other app you are using."], connection: ["远程连接", "Remote connection"], address: ["服务器地址", "Server address"], authPassword: ["认证密码", "Authentication password"], show: ["显示", "Show"], hide: ["隐藏", "Hide"], clearTarget: ["清空输入", "Clear inputs"], clickHint: ["标题用来展开，字段值用来粘贴。密码保持隐藏时，也可以直接点击。", "Click a title to expand it. Click a value to paste it, even when a password is hidden."], synthetic: ["仅使用合成示例", "Synthetic examples only"], boundary: ["内容只保留在本页内存中。复制与粘贴仅在原型内演示，不读写系统剪贴板，也不连接真实保险箱。", "Content stays in page memory. Copy and paste are simulated within this prototype, with no system clipboard or real vault access."], specLink: ["查看完整方案 ↗", "Read the full proposal ↗"], search: ["搜索标题、标签或字段", "Search titles, tags or fields"], newEntry: ["新建条目", "New entry"], create: ["新建", "New"], count: ["个条目", "entries"], settings: ["保险箱选项", "Vault options"], generator: ["密码生成器", "Password generator"], serverTitle: ["远端服务器相关", "Remote server details"], loginTitle: ["GitHub · 工作", "GitHub · Work"], apiTitle: ["项目 API 凭据", "Project API credentials"], recoveryTitle: ["账号恢复资料", "Account recovery details"], server: ["服务器", "Server"], login: ["网站账号", "Website account"], custom: ["自定义", "Custom"], database: ["数据库", "Database"], api: ["API 凭据", "API credentials"], recovery: ["恢复资料", "Recovery details"], personal: ["个人资料", "Personal details"], work: ["工作资料", "Work details"], ip: ["IP / 主机地址", "IP / hostname"], password: ["密码", "Password"], username: ["账号", "Username"], url: ["网址", "Website URL"], serviceUrl: ["服务地址", "Service URL"], apiKey: ["API Key", "API Key"], codes: ["恢复码", "Recovery codes"], verification: ["验证方式", "Verification method"], databaseName: ["数据库名", "Database name"], name: ["姓名", "Full name"], nickname: ["昵称", "Nickname"], birthday: ["生日", "Birthday"], country: ["国家 / 地区", "Country / region"], contactAddress: ["联系地址", "Contact address"], company: ["公司", "Company"], role: ["职务", "Job title"], email: ["邮箱", "Email"], workEmail: ["工作邮箱", "Work email"], employee: ["员工编号", "Employee ID"], phone: ["手机号", "Phone"], port: ["端口", "Port"], notes: ["备注", "Notes"], securityQuestion: ["安全问题答案", "Security answer"], sms: ["短信验证", "SMS verification"], authenticator: ["验证器说明", "Authenticator details"], passkey: ["通行密钥 / 安全密钥说明", "Passkey / security key details"], customVerification: ["自定义验证内容", "Custom verification"], copy: ["复制", "Copy"], paste: ["粘贴", "Paste"], edit: ["编辑条目", "Edit entry"], deleteEntry: ["删除条目", "Delete entry"], openUrl: ["打开网址（演示）", "Open URL (demo)"], rowHint: ["点击字段值，粘贴到此前选中的输入框", "Click a value to paste into the selected input"], footHint: ["复制的内容保留 30 秒。保险箱内容不进入剪贴板历史。", "Copied values expire after 30 seconds. Vault content stays out of clipboard history."], back: ["返回", "Back"], choose: ["选择一个起点", "Choose a starting point"], chooseBody: ["用预设开始，或只添加自己需要的字段。所有字段都可以修改。", "Start with a preset, or add only the fields you need. Every field can be changed."], customHint: ["空白条目，按需添加字段", "Start empty. Add what you need."], loginHint: ["网址、账号与密码", "Website, username and password"], serverHint: ["只包含 IP / 主机地址与认证密码", "Just IP / hostname and authentication password"], databaseHint: ["主机地址、数据库名、账号与密码", "Host, database, username and password"], apiHint: ["服务地址与 API Key", "Service URL and API key"], recoveryHint: ["恢复码与验证资料", "Recovery codes and verification details"], personalHint: ["姓名、昵称、生日及联系方式", "Name, nickname, birthday and contact details"], workHint: ["姓名、公司及工作资料", "Name, company and work details"], more: ["更多预设", "More presets"], less: ["收起更多预设", "Hide more presets"], searchPresets: ["搜索预设", "Search presets"], entryTitle: ["条目标题", "Entry title"], titleHint: ["例如：远端服务器相关", "e.g. Remote server details"], fieldName: ["字段名称", "Field name"], fieldValue: ["字段内容", "Field value"], sensitive: ["敏感", "Sensitive"], text: ["单行文字", "Single-line text"], secret: ["密码 / 密钥", "Password / key"], multiline: ["多行文字", "Multi-line text"], addField: ["添加字段", "Add field"], moveUp: ["上移字段", "Move field up"], moveDown: ["下移字段", "Move field down"], removeField: ["删除字段", "Remove field"], optional: ["标签与更多信息", "Tags and more"], tags: ["标签，以逗号分隔", "Tags, separated by commas"], summary: ["列表摘要", "List summary"], automatic: ["自动选择非敏感字段", "Choose a non-sensitive field automatically"], cancel: ["取消", "Cancel"], save: ["保存条目", "Save entry"], saving: ["保存中…", "Saving…"], titleRequired: ["请填写条目标题。", "Enter a title for this entry."], labelRequired: ["请为每个字段填写名称。", "Give every field a name."], tooLarge: ["字段或条目内容超出方案中的容量限制。", "Field or entry exceeds the proposal's size limits."], tooMany: ["字段最多 128 个，标签最多 20 个。", "Up to 128 fields and 20 tags are allowed."], noResults: ["没有匹配的条目", "No matching entries"], noResultsBody: ["试试标题、标签或非敏感字段中的文字。", "Try a title, tag or text from a non-sensitive field."], emptyTitle: ["从一个条目开始", "Start with one entry"], emptyBody: ["只保存需要的字段，不必填满一张表单。", "Save just the fields you need."], clearSearch: ["清除搜索", "Clear search"], emptyEntry: ["这个条目还没有内容。", "This entry has no content yet."], selectedHost: ["已选择服务器地址输入框", "Server address input selected"], selectedPassword: ["已选择认证密码输入框", "Authentication password input selected"], noTarget: ["请先点击右侧的目标输入框，再点击字段值。", "Select a target input in the demo panel first."], pasted: ["已粘贴到示例输入框", "Pasted into the demo input"], copied: ["已复制到原型暂存区，30 秒后清除", "Copied to the demo buffer; clears in 30 seconds"], expired: ["原型暂存区已到期清除", "Demo copy buffer cleared after expiry"], urlDemo: ["网址打开入口已触发（原型不会跳转）。", "Open URL action triggered (no navigation in the prototype)."], discardTitle: ["放弃本次修改？", "Discard these changes?"], discardBody: ["未保存的修改会被移除。", "Your unsaved changes will be removed."], discard: ["放弃修改", "Discard changes"], keepEditing: ["继续编辑", "Keep editing"], deleteTitle: ["删除这个条目？", "Delete this entry?"], deleteBody: ["本页中的示例条目将被删除，可用顶部「重置示例」恢复。", "This demo entry will be removed. Use Reset examples to restore it."], delete: ["删除", "Delete"], removeTitle: ["删除这个字段？", "Remove this field?"], removeBody: ["字段已有内容，删除后需重新添加。", "This field contains text. Removing it also removes its value."], sensitiveTitle: ["取消敏感保护？", "Make this field non-sensitive?"], sensitiveBody: ["字段值将直接显示，并允许搜索和列表摘要使用。", "Its value will be visible and eligible for search and list summaries."], makeVisible: ["取消敏感", "Make non-sensitive"], lockDraftTitle: ["锁定并放弃修改？", "Lock and discard changes?"], lockDraftBody: ["锁定会清除当前未保存草稿。", "Locking clears your unsaved draft."], lockNow: ["锁定", "Lock"], autoLock: ["自动锁定", "Auto-lock"], threeHours: ["三小时（默认）", "Three hours (default)"], day: ["24 小时", "24 hours"], never: ["永不自动锁定", "Never automatically"], startup: ["第一次打开应用时", "On app startup"], lockNote: ["隐藏和最小化不立即锁定。完全退出后仍需重新解锁。", "Hiding or minimizing does not immediately lock the vault. A full restart requires unlocking again."], optionDemo: ["此处只演示设置界面，不运行真实空闲计时。", "This is a settings preview; no real inactivity timer runs."], length: ["密码长度", "Password length"], regenerate: ["重新生成", "Generate again"], usePassword: ["使用此密码", "Use password"], generatorDemo: ["生成结果仅用于原型示例。", "Generated values are for this prototype only."], saved: ["示例条目已保存到本页内存", "Demo entry saved in page memory"], resetTitle: ["重置全部示例？", "Reset all examples?"], resetBody: ["本页新增的条目和未保存修改会被清除。", "Your new entries and unsaved changes in this page will be cleared."], resetNow: ["重置", "Reset"], generated: ["新密码已填入当前字段", "New password inserted into this field"], newLabel: ["自定义字段", "Custom field"], chooseTarget: ["还未选择目标输入框", "No target input selected"], total: ["全部条目", "All entries"]
};
const state = { lang: "zh", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", view: "list", mode: "identities", identityId: null, filter: "all", createKind: "entry", locked: false, entries: [], open: "server-example", search: "", revealed: new Set(), draft: null, dirty: false, more: false, presetSearch: "", picker: false, autoLock: "3hours", target: null, targetRange: [0, 0], clipboard: null, copyTimer: undefined, noticeTimer: undefined, pasteCount: 0, saving: false };
const tr = key => words[key]?.[state.lang === "zh" ? 0 : 1] ?? key;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = name => window.VAULT_ICONS[name] || "";
const uid = () => crypto.randomUUID();
const label = field => field.labelKey ? tr(field.labelKey) : field.label;
const title = entry => entry.titleKey ? tr(entry.titleKey) : entry.title;
const field = (key, value = "", sensitive = false, type = "text") => ({ id: uid(), labelKey: key, label: tr(key), value, sensitive, type });
const templates = [
    { id: "custom", glyph: "add", fields: [] }, { id: "login", glyph: "link", fields: [["url", "url"], ["username", "text"], ["password", "secret", true]] },
    { id: "server", glyph: "server", fields: [["ip", "text"], ["authPassword", "secret", true]] },
    { id: "database", glyph: "server", fields: [["ip", "text"], ["databaseName", "text"], ["username", "text"], ["password", "secret", true]] },
    { id: "api", glyph: "key", fields: [["serviceUrl", "url"], ["apiKey", "secret", true]] },
    { id: "recovery", glyph: "key", fields: [["codes", "multiline", true]] },
    { id: "personal", glyph: "notes", fields: [["name", "text"], ["nickname", "text"], ["birthday", "text"], ["country", "text"], ["contactAddress", "multiline"]] },
    { id: "work", glyph: "notes", fields: [["name", "text"], ["company", "text"], ["role", "text"], ["workEmail", "text"], ["employee", "text"]] }
];
function fixtures() {
    return [
        ...identityFixtures(),
        { id: "server-example", identityIds: ["identity-work"], titleKey: "serverTitle", title: tr("serverTitle"), template: "server", tags: [], fields: [field("ip", "203.0.113.24"), field("authPassword", "Demo!q7-River-84", true, "secret")] },
        { id: "login-example", identityIds: ["identity-work"], loginMethod: "passwordLogin", titleKey: "loginTitle", title: tr("loginTitle"), template: "login", tags: [], fields: [field("url", "https://github.com", false, "url"), field("username", "lin.work@example.com"), field("password", "Demo!Maple-27", true, "secret"), field("email", "lin.work@example.com")] },
        { id: "api-example", identityIds: [], titleKey: "apiTitle", title: tr("apiTitle"), template: "api", tags: [], fields: [field("serviceUrl", "https://api.example.com/v1", false, "url"), field("apiKey", "demo_only_key_8y4_x2", true, "secret")] },
        { id: "recovery-example", identityIds: ["identity-personal"], titleKey: "recoveryTitle", title: tr("recoveryTitle"), template: "recovery", tags: [], fields: [field("codes", "DEMO-R4K8-72QZ\nDEMO-N6W3-95AX", true, "multiline")] }
    ];
}
state.entries = fixtures();
const content = document.querySelector("#content");
function actionButton(action, glyph, text, extra = "", classes = "icon-button") { return `<button type="button" class="${classes}" data-action="${action}" aria-label="${esc(text)}" title="${esc(text)}" ${extra}>${icon(glyph)}${classes.includes("quiet") ? esc(text) : ""}</button>`; }
function notify(key, error = false) { clearTimeout(state.noticeTimer); const el = document.querySelector("#feedback"); el.textContent = tr(key); el.classList.toggle("error", error); el.hidden = false; state.noticeTimer = setTimeout(() => { el.hidden = true; }, 4000); }
function clearNotice() { clearTimeout(state.noticeTimer); document.querySelector("#feedback").hidden = true; }
function summary(entry) { const f = entry.fields.find(f => f.id === entry.summaryId && !f.sensitive && f.value) || entry.fields.find(f => !f.sensitive && f.value); return f ? f.value.replace(/\s+/g, " ").slice(0, 100) : ""; }
function matches(entry, query) { const values = [title(entry), ...entry.tags, ...entry.fields.flatMap(f => [label(f), ...(!f.sensitive ? [f.value] : [])])].join(" ").toLowerCase(); return query.toLowerCase().trim().split(/\s+/).every(term => values.includes(term)); }
function row(entry, f) { const isRevealed = state.revealed.has(f.id); return `<div class="field-row"><div class="field-body"><span class="field-label">${esc(label(f))}</span><button type="button" class="field-value ${f.sensitive || ["ip", "apiKey"].includes(f.labelKey) ? "mono" : ""}" data-action="paste" data-entry="${esc(entry.id)}" data-field="${esc(f.id)}" aria-label="${esc(tr("paste") + " " + label(f))}">${esc(f.sensitive && !isRevealed ? "••••••••••••" : f.value)}</button></div><div class="field-actions">${f.sensitive ? `<button type="button" class="quiet" data-action="reveal" data-field="${esc(f.id)}" aria-label="${esc(tr(isRevealed ? "hide" : "show") + " " + label(f))}">${tr(isRevealed ? "hide" : "show")}</button>` : ""}${f.type === "url" ? actionButton("url", "link", tr("openUrl"), `data-entry="${entry.id}" data-field="${f.id}"`) : ""}${actionButton("copy", "copy", tr("copy") + " " + label(f), `data-entry="${entry.id}" data-field="${f.id}"`)}</div></div>`; }
function renderList() { renderVaultHome(); }
function renderEntries() { renderVaultResults(); }
function templateOption(t) { return `<button type="button" class="template-option" data-action="template" data-template="${t.id}"><span class="entry-symbol">${icon(t.glyph)}</span><span><strong>${tr(t.id)}</strong><small>${tr(t.id + "Hint")}</small></span><span class="entry-chevron">›</span></button>`; }
function viewTop(text) { return `<div class="view-top"><button type="button" class="quiet back-button" data-action="back">‹ ${tr("back")}</button><h2>${tr(text)}</h2></div>`; }
function renderTemplates() {
    if (state.createKind === "identity") {
        content.innerHTML = `${viewTop("newIdentity")}<p class="view-intro">${tr("identityIntro")}</p><div class="template-list">${identityTemplates.map(templateOption).join("")}</div>`;
        return;
    }
    content.innerHTML = `${viewTop("newEntry")}<p class="view-intro">${tr("chooseBody")}</p><div class="template-list">${templates.slice(0, 3).map(templateOption).join("")}</div><button type="button" class="quiet more-presets" data-action="more" aria-expanded="${state.more}">${state.more ? "−" : "+"} ${tr(state.more ? "less" : "more")}</button>${state.more ? `<div class="preset-more"><div class="search-wrap">${icon("search")}<input id="preset-search" aria-label="${tr("searchPresets")}" placeholder="${tr("searchPresets")}" value="${esc(state.presetSearch)}"></div><div id="preset-list" class="preset-scroll"></div></div>` : ""}`;
    if (state.more)
        renderPresetList();
}
function renderPresetList() { document.querySelector("#preset-list").innerHTML = templates.slice(3).filter(t => tr(t.id).toLowerCase().includes(state.presetSearch.toLowerCase())).map(templateOption).join("") || `<p class="settings-caption">${tr("noResults")}</p>`; }
function newDraft(template) { const t = findTemplate(template); state.draft = { id: uid(), title: "", template, kind: state.createKind, identityIds: state.createKind === "identity" ? [] : selectedIdentity() ? [state.identityId] : state.mode === "all" && identities().some(i => i.id === state.filter) ? [state.filter] : [], tags: [], fields: t.fields.map(([key, type, sensitive]) => field(key, "", !!sensitive, type)) }; state.dirty = false; state.picker = false; state.revealed.clear(); state.view = "editor"; render(); document.querySelector("#entry-title").focus(); }
function typeOptions(f) { return ["text", "secret", "url", "multiline"].map(type => `<option value="${type}" ${f.type === type ? "selected" : ""}>${tr(type)}</option>`).join(""); }
function editorField(f, index) { const visible = !f.sensitive || state.revealed.has(f.id); return `<section class="editor-field" data-field="${f.id}"><div class="editor-field-head"><input class="editor-label" data-input="label" data-field="${f.id}" aria-label="${tr("fieldName")}" placeholder="${tr("fieldName")}" value="${esc(label(f))}" maxlength="80" required>${actionButton("move-up", "up", tr("moveUp"), `data-field="${f.id}" ${index === 0 ? "disabled" : ""}`)}${actionButton("move-down", "down", tr("moveDown"), `data-field="${f.id}" ${index === state.draft.fields.length - 1 ? "disabled" : ""}`)}${actionButton("remove", "delete", tr("removeField"), `data-field="${f.id}"`, "icon-button danger")}</div><div class="editor-field-value">${f.type === "multiline" ? `<textarea data-input="value" data-field="${f.id}" aria-label="${esc(label(f) || tr("fieldValue"))}" rows="3" ${!visible ? "readonly" : ""}>${esc(visible ? f.value : "••••••••••••")}</textarea>` : `<input data-input="value" data-field="${f.id}" aria-label="${esc(label(f) || tr("fieldValue"))}" type="${visible ? "text" : "password"}" value="${esc(f.value)}" autocomplete="off" spellcheck="false">`}${f.sensitive ? `<button type="button" class="quiet" data-action="editor-reveal" data-field="${f.id}">${tr(visible ? "hide" : "show")}</button>` : ""}</div><div class="editor-field-meta"><select data-input="type" data-field="${f.id}" aria-label="${esc(label(f) + " " + tr("text"))}">${typeOptions(f)}</select><label class="sensitive-toggle"><input type="checkbox" data-input="sensitive" data-field="${f.id}" ${f.sensitive ? "checked" : ""}>${tr("sensitive")}</label></div>${f.type === "secret" ? `<button type="button" class="quiet" data-action="generate-field" data-field="${f.id}">${tr("generator")}</button>` : ""}</section>`; }
const addFields = [...["text", "secret", "url", "multiline"].map(type => ({ key: type, type, sensitive: type === "secret" })), { key: "username", type: "text" }, { key: "email", type: "text" }, { key: "phone", type: "text" }, { key: "port", type: "text" }, { key: "notes", type: "multiline" }, { key: "codes", type: "multiline", sensitive: true }, { key: "securityQuestion", type: "multiline", sensitive: true }, { key: "authenticator", type: "multiline" }, { key: "passkey", type: "multiline" }, { key: "customVerification", type: "multiline", sensitive: true }, { key: "sms", type: "text" }];
function summaryOptions() {
    const select = document.querySelector("#summary-field");
    if (!select)
        return;
    select.innerHTML = `<option value="">${tr("automatic")}</option>` + state.draft.fields.filter(f => !f.sensitive).map(f => `<option value="${f.id}" ${state.draft.summaryId === f.id ? "selected" : ""}>${esc(label(f))}</option>`).join("");
}
function renderEditor() { const entry = state.draft; content.innerHTML = `${viewTop(isIdentity(entry) ? state.entries.some(e => e.id === entry.id) ? "editIdentity" : "newIdentity" : state.entries.some(e => e.id === entry.id) ? "edit" : "newEntry")}<form id="editor" autocomplete="off"><input id="entry-title" class="editor-title" aria-label="${tr(isIdentity(entry) ? "identityTitle" : "entryTitle")}" placeholder="${tr(isIdentity(entry) ? "identityTitleHint" : "titleHint")}" value="${esc(title(entry))}" maxlength="120" required>${identityEditor(entry)}<div class="editor-fields">${entry.fields.map(editorField).join("")}</div><button type="button" class="quiet field-add" data-action="picker" aria-expanded="${state.picker}" ${entry.fields.length >= 128 ? "disabled" : ""}>${icon("add")}${tr("addField")}</button>${state.picker ? `<div class="field-picker">${addFields.map((f, i) => `<button type="button" data-action="add-field" data-index="${i}">${tr(f.key)}</button>`).join("")}</div>` : ""}<details class="optional"><summary>${tr("optional")}</summary><label for="entry-tags">${tr("tags")}</label><input id="entry-tags" value="${esc(entry.tags.join(", "))}"><label class="settings-label" for="summary-field">${tr("summary")}</label><select id="summary-field"></select></details><p id="editor-error" class="inline-error" role="alert" hidden></p><div class="editor-footer"><button type="button" class="button secondary" data-action="back">${tr("cancel")}</button><button type="submit" class="button primary" id="save-entry">${tr(isIdentity(entry) ? "saveIdentity" : "save")}</button></div></form>`; summaryOptions(); }
function renderSettings() { content.innerHTML = `${viewTop("settings")}<section class="settings-row"><label class="settings-label" for="auto-lock">${tr("autoLock")}</label><select id="auto-lock">${[["3hours", "threeHours"], ["24hours", "day"], ["never", "never"], ["on_startup", "startup"]].map(([value, key]) => `<option value="${value}" ${state.autoLock === value ? "selected" : ""}>${tr(key)}</option>`).join("")}</select><p class="settings-caption">${tr("lockNote")}</p><p class="settings-caption">${tr("optionDemo")}</p></section><section class="settings-row"><button type="button" class="button secondary" data-action="generator">${icon("key")}${tr("generator")}</button></section>`; }
function generate(length = 24) {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%&*"];
    const all = sets.join("");
    const random = n => {
        const limit = 256 - 256 % n;
        const bytes = new Uint8Array(1);
        do {
            crypto.getRandomValues(bytes);
        } while (bytes[0] >= limit);
        return bytes[0] % n;
    };
    const values = sets.map(s => s[random(s.length)]);
    while (values.length < length)
        values.push(all[random(all.length)]);
    for (let i = values.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [values[i], values[j]] = [values[j], values[i]];
    }
    return values.join("");
}
function renderGenerator() { content.innerHTML = `${viewTop("generator")}<label class="settings-label" for="password-length">${tr("length")}</label><input id="password-length" type="number" min="12" max="64" value="24"><div id="generated-password" class="generator-result"></div><div class="generator-buttons"><button type="button" class="button secondary" data-action="regenerate">${tr("regenerate")}</button><button type="button" class="button primary" data-action="copy-generated">${tr("copy")}</button></div><p class="settings-caption">${tr("generatorDemo")}</p>`; document.querySelector("#generated-password").textContent = generate(); }
function render() {
    clearNotice();
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.theme = state.theme;
    document.title = `${tr("prototype")} · Copy Creator`;
    document.querySelector(".sidebar").setAttribute("aria-label", state.lang === "zh" ? "模块" : "Modules");
    document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = tr(el.dataset.i18n));
    document.querySelectorAll("[data-icon]").forEach(el => el.innerHTML = icon(el.dataset.icon));
    document.querySelector("#theme").textContent = tr(state.theme === "dark" ? "light" : "dark");
    document.querySelector("#language").textContent = state.lang === "zh" ? "English" : "中文";
    document.querySelector("#vault-nav").title = tr("vault");
    for (const [key, labelKey] of [["clipboard", "剪贴板"], ["notes", "随记"], ["translate", "翻译"]])
        document.querySelector(`[data-nav="${key}"]`).title = state.lang === "zh" ? `${labelKey}（本原型仅展示保险箱）` : `${key} (vault prototype only)`;
    document.querySelector("#lock-state").textContent = tr(state.locked ? "locked" : "unlocked");
    document.querySelector("#lock").hidden = state.locked;
    document.querySelector("#lock").title = tr("lock");
    document.querySelector("#lock").setAttribute("aria-label", tr("lock"));
    document.querySelector("#target-reveal").textContent = tr(document.querySelector("#target-password").type === "password" ? "show" : "hide");
    document.querySelector('.preview-bar [data-i18n="prototype"]').textContent = tr("identityPrototype");
    document.querySelector('[data-i18n="tryTitle"]').textContent = tr("identityTry");
    document.querySelector('[data-i18n="tryIntro"]').textContent = tr("identityTryIntro");
    document.querySelector('[data-i18n="connection"]').textContent = tr("demoTarget");
    document.querySelector('[data-i18n="address"]').textContent = tr("targetText");
    updateTargetStatus();
    if (state.locked) {
        content.innerHTML = `<section class="gate"><div class="gate-icon">${icon("vault")}</div><h2>${tr("gateTitle")}</h2><p>${tr("gateBody")}</p><button type="button" class="button primary" data-action="unlock">${tr("unlock")}</button><p class="gate-caption">${tr("gateNote")}</p></section>`;
        return;
    }
    if (state.view === "templates")
        renderTemplates();
    else if (state.view === "editor")
        renderEditor();
    else if (state.view === "settings")
        renderSettings();
    else if (state.view === "generator")
        renderGenerator();
    else
        renderList();
}
function updateTargetStatus() { document.querySelector("#target-status").textContent = tr(state.target === "target-host" ? "selectedText" : state.target === "target-password" ? "selectedPassword" : "chooseTarget"); document.querySelectorAll(".target-input").forEach(input => input.classList.toggle("target-active", input.id === state.target)); }
function confirmAction(titleKey, bodyKey, acceptKey, callback, cancelKey = "cancel") { const dialog = document.querySelector("#confirm-dialog"); document.querySelector("#confirm-title").textContent = tr(titleKey); document.querySelector("#confirm-description").textContent = tr(bodyKey); document.querySelector("#confirm-cancel").textContent = tr(cancelKey); document.querySelector("#confirm-accept").textContent = tr(acceptKey); document.querySelector("#confirm-accept").onclick = () => { dialog.close(); callback(); }; dialog.showModal(); document.querySelector("#confirm-cancel").focus(); }
document.querySelector("#confirm-cancel").onclick = () => document.querySelector("#confirm-dialog").close();
function back() {
    const go = () => { state.draft = null; state.dirty = false; state.picker = false; state.revealed.clear(); state.view = "list"; render(); content.scrollTop = 0; };
    if (state.view === "editor" && state.dirty)
        confirmAction("discardTitle", "discardBody", "discard", go, "keepEditing");
    else
        go();
}
function lock() {
    const go = () => { state.locked = true; state.draft = null; state.dirty = false; state.search = ""; state.open = null; state.identityId = null; state.revealed.clear(); state.target = null; state.view = "list"; render(); };
    if (state.dirty)
        confirmAction("lockDraftTitle", "lockDraftBody", "lockNow", go, "keepEditing");
    else
        go();
}
function copyDemo(value) { clearTimeout(state.copyTimer); state.clipboard = value; notify("copied"); state.copyTimer = setTimeout(() => { state.clipboard = null; notify("expired"); }, 30000); }
function pasteDemo(entryId, fieldId) {
    if (state.locked || state.saving)
        return;
    const entry = state.entries.find(e => e.id === entryId);
    const f = entry?.fields.find(f => f.id === fieldId);
    const target = state.target && document.getElementById(state.target);
    if (!f?.value || !target?.isConnected) {
        notify("noTarget", true);
        return;
    }
    const [start, end] = state.targetRange;
    target.setRangeText(f.value, start, end, "end");
    state.targetRange = [target.selectionStart, target.selectionEnd];
    state.pasteCount++;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    notify("pasted");
}
function saveDraft(event) {
    event.preventDefault();
    if (state.saving)
        return;
    const draft = state.draft;
    draft.title = document.querySelector("#entry-title").value.trim();
    delete draft.titleKey;
    draft.tags = document.querySelector("#entry-tags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const error = document.querySelector("#editor-error");
    let issue = "";
    if (!draft.title)
        issue = "titleRequired";
    else if (draft.fields.some(f => !label(f).trim()))
        issue = "labelRequired";
    else if (draft.fields.length > 128 || draft.tags.length > 20)
        issue = "tooMany";
    else if (draft.fields.some(f => new TextEncoder().encode(f.value).length > 16384) || new TextEncoder().encode(JSON.stringify(draft)).length > 262144 || draft.tags.some(tag => Array.from(tag).length > 40))
        issue = "tooLarge";
    if (issue) {
        error.textContent = tr(issue);
        error.hidden = false;
        return;
    }
    const invalidUrl = draft.fields.find(f => f.type === "url" && f.value && !safeUrl(f.value));
    if (invalidUrl) {
        error.textContent = state.lang === "zh" ? "网址仅支持 HTTP / HTTPS，且不能内嵌账号密码。" : "Use an HTTP or HTTPS URL without embedded credentials.";
        error.hidden = false;
        return;
    }
    state.saving = true;
    document.querySelector("#save-entry").disabled = true;
    document.querySelector("#save-entry").textContent = tr("saving");
    setTimeout(() => {
        if (state.locked || state.draft !== draft) {
            state.saving = false;
            return;
        }
        draft.fields.forEach(f => {
            f.label = label(f).trim();
            delete f.labelKey;
            if (f.type === "url" && f.value)
                f.value = safeUrl(f.value);
        });
        const index = state.entries.findIndex(e => e.id === draft.id);
        if (index >= 0)
            state.entries[index] = structuredClone(draft);
        else
            state.entries.unshift(structuredClone(draft));
        state.open = draft.id;
        if (isIdentity(draft)) {
            state.mode = "identities";
            state.identityId = draft.id;
        }
        state.draft = null;
        state.dirty = false;
        state.saving = false;
        state.view = "list";
        state.search = "";
        state.revealed.clear();
        render();
        content.scrollTop = 0;
        notify(isIdentity(draft) ? "identitySaved" : "saved");
    }, 250);
}
function safeUrl(value) {
    try {
        const url = new URL(value.includes("://") ? value : `https://${value}`);
        return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
    }
    catch {
        return null;
    }
}
document.querySelector("#lock").onclick = lock;
document.querySelector("#vault-nav").onclick = () => {
    if (!state.locked)
        back();
};
document.querySelector("#theme").onclick = () => { state.theme = state.theme === "dark" ? "light" : "dark"; render(); };
document.querySelector("#language").onclick = () => { state.lang = state.lang === "zh" ? "en" : "zh"; render(); };
document.querySelector("#reset").onclick = () => confirmAction("resetTitle", "resetBody", "resetNow", () => {
    clearTimeout(state.copyTimer);
    state.entries = fixtures();
    state.mode = "identities";
    state.identityId = null;
    state.filter = "all";
    state.createKind = "entry";
    state.clipboard = null;
    state.view = "list";
    state.locked = false;
    state.draft = null;
    state.dirty = false;
    state.saving = false;
    state.search = "";
    state.open = "server-example";
    state.revealed.clear();
    state.target = null;
    state.pasteCount = 0;
    for (const input of document.querySelectorAll(".target-input"))
        input.value = "";
    render();
});
document.querySelector("#target-reveal").onclick = () => { const input = document.querySelector("#target-password"); input.type = input.type === "password" ? "text" : "password"; document.querySelector("#target-reveal").textContent = tr(input.type === "password" ? "show" : "hide"); };
document.querySelector("#clear-target").onclick = () => { document.querySelectorAll(".target-input").forEach(input => input.value = ""); state.target = null; state.targetRange = [0, 0]; updateTargetStatus(); };
document.querySelectorAll(".target-input").forEach(input => {
    const remember = () => { state.target = input.id; state.targetRange = [input.selectionStart ?? 0, input.selectionEnd ?? 0]; updateTargetStatus(); };
    input.addEventListener("focus", remember);
    input.addEventListener("select", remember);
    input.addEventListener("keyup", remember);
    input.addEventListener("click", remember);
    input.addEventListener("input", () => {
        if (state.target === input.id)
            state.targetRange = [input.selectionStart ?? 0, input.selectionEnd ?? 0];
    });
});
content.addEventListener("submit", saveDraft);
content.addEventListener("input", event => {
    const el = event.target;
    if (el.id === "search") {
        state.search = el.value;
        renderEntries();
        return;
    }
    if (el.id === "preset-search") {
        state.presetSearch = el.value;
        renderPresetList();
        return;
    }
    if (el.id === "entry-title") {
        state.draft.title = el.value;
        delete state.draft.titleKey;
        state.dirty = true;
        return;
    }
    if (el.id === "login-note") {
        state.draft.loginNote = el.value;
        state.dirty = true;
        return;
    }
    if (el.id === "entry-tags") {
        state.draft.tags = el.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        state.dirty = true;
        return;
    }
    if (el.dataset.input === "label" || el.dataset.input === "value") {
        const f = state.draft.fields.find(f => f.id === el.dataset.field);
        if (el.dataset.input === "label") {
            f.label = el.value;
            delete f.labelKey;
            summaryOptions();
        }
        else
            f.value = el.value;
        state.dirty = true;
    }
});
content.addEventListener("change", event => {
    const el = event.target;
    if (el.id === "identity-filter") {
        state.filter = el.value;
        state.open = null;
        state.revealed.clear();
        renderEntries();
        return;
    }
    if (el.dataset.input === "identity-link") {
        const ids = new Set(state.draft.identityIds || []);
        el.checked ? ids.add(el.value) : ids.delete(el.value);
        state.draft.identityIds = [...ids];
        state.dirty = true;
        el.closest("label").classList.toggle("chosen", el.checked);
        return;
    }
    if (el.id === "login-method") {
        state.draft.loginMethod = el.value;
        state.dirty = true;
        return;
    }
    if (el.id === "auto-lock") {
        state.autoLock = el.value;
        return;
    }
    if (el.id === "summary-field") {
        state.draft.summaryId = el.value;
        state.dirty = true;
        return;
    }
    const f = state.draft?.fields.find(f => f.id === el.dataset.field);
    if (!f)
        return;
    if (el.dataset.input === "type") {
        f.type = el.value;
        if (f.type === "secret")
            f.sensitive = true;
        state.dirty = true;
        renderEditor();
    }
    if (el.dataset.input === "sensitive") {
        if (!el.checked) {
            el.checked = true;
            confirmAction("sensitiveTitle", "sensitiveBody", "makeVisible", () => { f.sensitive = false; state.dirty = true; renderEditor(); });
        }
        else {
            f.sensitive = true;
            if (state.draft.summaryId === f.id)
                delete state.draft.summaryId;
            state.dirty = true;
            renderEditor();
        }
    }
});
content.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled)
        return;
    const a = button.dataset.action;
    if (identityAction(a, button))
        return;
    const id = button.dataset.field;
    const f = state.draft?.fields.find(f => f.id === id);
    if (a === "paste") {
        const selection = getSelection();
        if (selection?.toString() && (button.contains(selection.anchorNode) || button.contains(selection.focusNode)))
            return;
        pasteDemo(button.dataset.entry, id);
    }
    else if (a === "copy") {
        const saved = state.entries.find(e => e.id === button.dataset.entry)?.fields.find(f => f.id === id);
        if (saved)
            copyDemo(saved.value);
    }
    else if (a === "reveal") {
        state.revealed.has(id) ? state.revealed.delete(id) : state.revealed.add(id);
        const profile = selectedIdentity();
        if (profile && profile.fields.some(field => field.id === id)) {
            const holder = document.querySelector(".identity-information > div");
            holder.innerHTML = profile.fields.filter(field => field.value).map(field => row(profile, field)).join("");
        }
        else
            renderEntries();
    }
    else if (a === "url")
        notify("urlDemo");
    else if (a === "expand") {
        state.open = state.open === button.dataset.entry ? null : button.dataset.entry;
        state.revealed.clear();
        renderEntries();
    }
    else if (a === "new") {
        state.createKind = "entry";
        state.view = "templates";
        state.more = false;
        state.presetSearch = "";
        render();
        content.scrollTop = 0;
    }
    else if (a === "more") {
        state.more = !state.more;
        renderTemplates();
    }
    else if (a === "template")
        newDraft(button.dataset.template);
    else if (a === "edit") {
        state.draft = structuredClone(state.entries.find(e => e.id === button.dataset.entry));
        state.dirty = false;
        state.view = "editor";
        state.picker = false;
        state.revealed.clear();
        render();
        content.scrollTop = 0;
    }
    else if (a === "delete-entry")
        confirmAction("deleteTitle", "deleteBody", "delete", () => { state.entries = state.entries.filter(e => e.id !== button.dataset.entry); state.open = null; render(); });
    else if (a === "clear-search") {
        state.search = "";
        renderList();
    }
    else if (a === "back")
        back();
    else if (a === "picker") {
        state.picker = !state.picker;
        renderEditor();
    }
    else if (a === "add-field") {
        if (state.draft.fields.length >= 128)
            return;
        const choice = addFields[Number(button.dataset.index)];
        state.draft.fields.push(field(["text", "secret", "url", "multiline"].includes(choice.key) ? "newLabel" : choice.key, "", !!choice.sensitive, choice.type));
        state.picker = false;
        state.dirty = true;
        renderEditor();
        const inputs = content.querySelectorAll(".editor-label");
        inputs[inputs.length - 1].focus();
        inputs[inputs.length - 1].select();
    }
    else if (a === "remove") {
        const remove = () => { state.draft.fields = state.draft.fields.filter(f => f.id !== id); state.dirty = true; renderEditor(); };
        if (f.value)
            confirmAction("removeTitle", "removeBody", "delete", remove);
        else
            remove();
    }
    else if (a === "move-up" || a === "move-down") {
        const fields = state.draft.fields;
        const index = fields.indexOf(f);
        const next = index + (a === "move-up" ? -1 : 1);
        if (next >= 0 && next < fields.length) {
            [fields[index], fields[next]] = [fields[next], fields[index]];
            state.dirty = true;
            renderEditor();
            content.querySelector(`[data-action="${a}"][data-field="${id}"]`)?.focus();
        }
    }
    else if (a === "editor-reveal") {
        state.revealed.has(id) ? state.revealed.delete(id) : state.revealed.add(id);
        renderEditor();
    }
    else if (a === "generate-field") {
        f.value = generate();
        state.dirty = true;
        renderEditor();
        notify("generated");
    }
    else if (a === "settings") {
        state.view = "settings";
        render();
    }
    else if (a === "generator") {
        state.view = "generator";
        render();
    }
    else if (a === "regenerate") {
        const length = Math.min(64, Math.max(12, Number(document.querySelector("#password-length").value) || 24));
        document.querySelector("#password-length").value = length;
        document.querySelector("#generated-password").textContent = generate(length);
    }
    else if (a === "copy-generated")
        copyDemo(document.querySelector("#generated-password").textContent);
    else if (a === "unlock") {
        state.locked = false;
        state.view = "list";
        render();
    }
});
render();
