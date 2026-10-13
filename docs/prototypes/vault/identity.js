/* Identity relationships are synthetic and kept in the same page memory as entries. */
"use strict";
const identityWords = {
    identities: ["身份档案", "Identities"], allDetails: ["全部资料", "All details"],
    identityIntro: ["从一个身份，找到它的联系方式与相关服务。", "Find contact details and services through an identity."],
    newIdentity: ["新建身份", "New identity"], editIdentity: ["编辑身份", "Edit identity"],
    identityTitle: ["身份名称", "Identity name"], identityTitleHint: ["例如：个人身份、工作身份", "e.g. Personal identity, Work identity"],
    identityPersonal: ["个人身份", "Personal identity"], identityWork: ["工作身份", "Work identity"], identityCustom: ["自定义身份", "Custom identity"],
    identityPersonalHint: ["常用邮箱、手机号与邮箱密码", "Personal email, phone and mailbox password"],
    identityWorkHint: ["工作邮箱、手机号与公司信息", "Work email, phone and company details"],
    identityCustomHint: ["只添加这个身份需要的信息", "Add only the information this identity needs"],
    personalMark: ["个", "P"], workMark: ["工", "W"], customMark: ["身", "I"],
    identityBasics: ["身份信息", "Identity details"], mailboxPassword: ["邮箱密码", "Mailbox password"],
    relatedDetails: ["关联资料", "Linked details"], linkedCount: ["项关联资料", "linked entries"],
    linkedIdentities: ["关联身份", "Linked identities"], chooseIdentities: ["选择关联身份（可多选）", "Link identities (optional, multiple allowed)"],
    relationshipHint: ["关联只用于归类；这项服务的密码单独保存。", "Links organize this entry. Its service password is stored separately."],
    identityHint: ["邮箱密码用于邮箱登录；网站和服务器的密码保存在各自资料中。", "Use the mailbox password for email. Keep website and server passwords in their own entries."],
    unlinked: ["独立资料", "Independent details"], unlinkedHint: ["无需关联身份，也可以单独保存和使用。", "Save and use entries without linking an identity."],
    independent: ["未关联身份", "No linked identity"], allIdentities: ["全部身份 / 独立资料", "All identities / independent"],
    identityFilter: ["按身份筛选资料", "Filter entries by identity"], identitySearch: ["搜索身份、邮箱或手机号", "Search identity, email or phone"],
    addRelated: ["添加关联资料", "Add linked entry"], backIdentities: ["所有身份", "All identities"],
    identityEmpty: ["建立你的第一个身份", "Create your first identity"], identityEmptyHint: ["整理常用邮箱、手机号，再关联已有服务。", "Organize email and phone details, then link your services."],
    relatedEmpty: ["这个身份还没有关联资料", "No entries linked yet"], relatedEmptyHint: ["新建一项资料，或编辑已有资料并关联这个身份。", "Create an entry here, or edit an existing entry to link this identity."],
    emptyIndependent: ["还没有独立资料", "No independent entries yet"],
    viewIdentity: ["查看身份", "View identity"], deleteIdentity: ["删除身份", "Delete identity"],
    deleteIdentityTitle: ["删除这个身份？", "Delete this identity?"],
    deleteIdentityBody: ["只删除身份档案及其关联关系。网站、服务器等资料会保留；没有其他关联的资料会移入「独立资料」。", "Only the identity and its links are removed. Service entries remain; those without other links become independent."],
    loginMethod: ["登录方式", "Sign-in method"], passwordLogin: ["账号与密码", "Username and password"],
    emailCodeLogin: ["邮箱验证码", "Email verification code"], phoneCodeLogin: ["手机验证码", "SMS verification code"],
    ssoLogin: ["第三方账号登录", "Sign in through another account"], otherLogin: ["其他方式", "Other method"],
    loginNote: ["登录说明（可选）", "Sign-in notes (optional)"], loginNoteHint: ["例如：使用工作 Google 账号登录", "e.g. Sign in with the work Google account"],
    loginMethodHint: ["选择方式只记录登录信息；字段仍由你增删。", "This records how you sign in. Add or remove fields as needed."],
    identityNeeded: ["先建立身份，再在这里关联。", "Create an identity first, then link it here."],
    identitySaved: ["示例身份已保存到本页内存", "Demo identity saved in page memory"],
    saveIdentity: ["保存身份", "Save identity"],
    profileOverview: ["联系方式与服务，在这里关联", "Contact details and services, connected"],
    identityTry: ["先选身份，再试试字段", "Choose an identity, then try a field"],
    identityTryIntro: ["打开「工作身份」查看邮箱和相关服务器。先选下面的输入框，再点邮箱、IP 或遮罩密码，体验单项填入。", "Open Work identity to see its email and server. Select an input below, then click an email, IP or masked password to try pasting one value."],
    demoTarget: ["示例输入框", "Demo inputs"], targetText: ["文字 / 账号 / 服务器地址", "Text / username / server address"],
    selectedText: ["已选择文字输入框", "Text input selected"],
    identityPrototype: ["身份与保险箱 · 交互原型", "Identity & vault · Prototype"]
};
const identityTemplates = [
    { id: "identityPersonal", glyph: "notes", fields: [["email", "text"], ["phone", "text"], ["mailboxPassword", "secret", true]] },
    { id: "identityWork", glyph: "notes", fields: [["workEmail", "text"], ["phone", "text"], ["mailboxPassword", "secret", true], ["company", "text"]] },
    { id: "identityCustom", glyph: "add", fields: [] }
];
const isIdentity = entry => entry?.kind === "identity";
const identities = () => state.entries.filter(isIdentity);
const details = () => state.entries.filter(entry => !isIdentity(entry));
const linkedIdentities = entry => identities().filter(identity => (entry.identityIds || []).includes(identity.id));
const relatedEntries = identity => details().filter(entry => (entry.identityIds || []).includes(identity.id));
const selectedIdentity = () => state.mode === "identities" && identities().find(entry => entry.id === state.identityId);
const findTemplate = id => [...templates, ...identityTemplates].find(template => template.id === id);
function identityFixtures() {
    const result = [
        { id: "identity-personal", kind: "identity", titleKey: "identityPersonal", template: "identityPersonal", tags: [], fields: [field("name", "林沐"), field("email", "lin.personal@example.com"), field("phone", "+1 202-555-0146"), field("mailboxPassword", "Demo!Personal-Mail-42", true, "secret")] },
        { id: "identity-work", kind: "identity", titleKey: "identityWork", template: "identityWork", tags: [], fields: [field("workEmail", "lin.work@example.com"), field("phone", "+1 202-555-0182"), field("mailboxPassword", "Demo!Work-Mail-63", true, "secret"), field("company", "山岚工作室（示例）")] }
    ];
    result.forEach(identity => identity.summaryId = identity.fields.find(field => ["email", "workEmail"].includes(field.labelKey)).id);
    return result;
}
function identityAvatar(identity, small = false) {
    const key = identity.template === "identityWork" ? "workMark" : identity.template === "identityPersonal" ? "personalMark" : "customMark";
    return `<span class="identity-avatar ${identity.template === "identityWork" ? "work-avatar" : ""} ${small ? "small-avatar" : ""}" aria-hidden="true">${tr(key)}</span>`;
}
function identityLinks(entry) {
    const linked = linkedIdentities(entry);
    return linked.length ? `<div class="identity-links" aria-label="${tr("linkedIdentities")}">${linked.map(identity => `<button type="button" class="identity-link" data-action="identity" data-entry="${esc(identity.id)}">${identityAvatar(identity, true)}${esc(title(identity))}<span aria-hidden="true">↗</span></button>`).join("")}</div>` : `<p class="independent-label">${tr("independent")}</p>`;
}
function identityEditor(entry) {
    if (isIdentity(entry))
        return `<p class="identity-editor-hint">${tr("identityHint")}</p>`;
    return `<fieldset class="identity-assignment"><legend>${tr("chooseIdentities")}</legend><div class="identity-choices">${identities().map(identity => `<label class="identity-choice ${(entry.identityIds || []).includes(identity.id) ? "chosen" : ""}"><input type="checkbox" data-input="identity-link" value="${esc(identity.id)}" ${(entry.identityIds || []).includes(identity.id) ? "checked" : ""}>${identityAvatar(identity, true)}<span>${esc(title(identity))}</span></label>`).join("") || `<p class="settings-caption">${tr("identityNeeded")}</p>`}</div><p>${tr("relationshipHint")}</p></fieldset>${entry.template === "login" ? `<div class="login-editor"><label class="form-label" for="login-method">${tr("loginMethod")}</label><select id="login-method">${["passwordLogin", "emailCodeLogin", "phoneCodeLogin", "ssoLogin", "otherLogin"].map(method => `<option value="${method}" ${(entry.loginMethod || "passwordLogin") === method ? "selected" : ""}>${tr(method)}</option>`).join("")}</select><label class="form-label" for="login-note">${tr("loginNote")}</label><input id="login-note" maxlength="200" value="${esc(entry.loginNote || "")}" placeholder="${tr("loginNoteHint")}"><p>${tr("loginMethodHint")}</p></div>` : ""}`;
}
function entryMarkup(entry) {
    const open = state.open === entry.id;
    return `<article class="entry ${open ? "open" : ""}" data-entry="${esc(entry.id)}"><div class="entry-head"><button type="button" class="entry-toggle" data-action="expand" data-entry="${esc(entry.id)}" aria-expanded="${open}" aria-controls="details-${esc(entry.id)}"><span class="entry-symbol">${icon(findTemplate(entry.template)?.glyph || "vault")}</span><span class="entry-description"><span class="entry-title">${esc(title(entry))}</span>${summary(entry) ? `<span class="entry-summary">${esc(summary(entry))}</span>` : ""}</span><span class="entry-chevron" aria-hidden="true">›</span></button>${actionButton("edit", "edit", tr("edit"), `data-entry="${esc(entry.id)}"`)}${open ? actionButton("delete-entry", "delete", tr("deleteEntry"), `data-entry="${esc(entry.id)}"`, "icon-button danger") : ""}</div>${open ? `<div class="entry-details" id="details-${esc(entry.id)}">${identityLinks(entry)}${entry.template === "login" ? `<div class="login-description"><span>${tr("loginMethod")}</span><strong>${tr(entry.loginMethod || "passwordLogin")}</strong>${entry.loginNote ? `<p>${esc(entry.loginNote)}</p>` : ""}</div>` : ""}${entry.fields.filter(f => f.value).map(f => row(entry, f)).join("") || `<p class="settings-caption">${tr("emptyEntry")}</p>`}${entry.tags.length ? `<div class="tags">${entry.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join("")}</div>` : ""}<p class="field-hint">${icon("paste")}${tr("rowHint")}</p></div>` : `<div class="collapsed-identity">${identityLinks(entry)}</div>`}</article>`;
}
function renderVaultHome() {
    const identity = selectedIdentity();
    const overview = state.mode === "identities" && !identity;
    content.innerHTML = `<nav class="vault-tabs" aria-label="${tr("vault")}"><button type="button" data-action="mode" data-mode="all" aria-pressed="${state.mode === "all"}">${tr("allDetails")}<span>${details().length}</span></button><button type="button" data-action="mode" data-mode="identities" aria-pressed="${state.mode === "identities"}">${tr("identities")}<span>${identities().length}</span></button></nav>${identity ? identityHeader(identity) : overview ? `<div class="identity-overview-heading"><h2>${tr("profileOverview")}</h2><p>${tr("identityIntro")}</p></div>` : ""}<div class="search-row"><div class="search-wrap">${icon("search")}<input id="search" aria-label="${tr(overview ? "identitySearch" : "search")}" placeholder="${tr(overview ? "identitySearch" : "search")}" value="${esc(state.search)}" autocomplete="off"></div><button type="button" class="button primary" data-action="${overview ? "new-identity" : "new"}" aria-label="${tr(overview ? "newIdentity" : identity ? "addRelated" : "newEntry")}">${icon("add")}<span class="create-label">${tr(overview ? "newIdentity" : "create")}</span></button></div>${state.mode === "all" ? `<select id="identity-filter" class="identity-filter" aria-label="${tr("identityFilter")}"><option value="all">${tr("allIdentities")}</option><option value="independent" ${state.filter === "independent" ? "selected" : ""}>${tr("unlinked")}</option>${identities().map(item => `<option value="${esc(item.id)}" ${state.filter === item.id ? "selected" : ""}>${esc(title(item))}</option>`).join("")}</select>` : ""}<div class="list-meta"><span id="entry-count"></span><button type="button" class="quiet" data-action="settings">${tr("settings")}</button></div><div id="entry-list" class="list"></div>${overview ? `<button type="button" class="independent-entry" data-action="independent"><span><strong>${tr("unlinked")}</strong><small>${tr("unlinkedHint")}</small></span><span class="independent-count">${details().filter(item => !linkedIdentities(item).length).length} <span aria-hidden="true">›</span></span></button>` : ""}<p class="list-foot">${tr("footHint")}</p>`;
    renderVaultResults();
}
function identityHeader(identity) {
    return `<div class="identity-detail-top"><button type="button" class="quiet" data-action="identity-back">‹ ${tr("backIdentities")}</button><div>${actionButton("edit", "edit", tr("editIdentity"), `data-entry="${esc(identity.id)}"`)}${actionButton("delete-identity", "delete", tr("deleteIdentity"), `data-entry="${esc(identity.id)}"`, "icon-button danger")}</div></div><section class="identity-profile"><div class="identity-profile-title">${identityAvatar(identity)}<div><h2>${esc(title(identity))}</h2><span>${relatedEntries(identity).length} ${tr("linkedCount")}</span></div></div><details class="identity-information" open><summary>${tr("identityBasics")}</summary><div>${identity.fields.filter(f => f.value).map(f => row(identity, f)).join("") || `<p class="settings-caption">${tr("emptyEntry")}</p>`}</div></details><p class="profile-separation">${tr("identityHint")}</p></section><h3 class="related-heading">${tr("relatedDetails")}</h3>`;
}
function renderVaultResults() {
    const identity = selectedIdentity();
    const overview = state.mode === "identities" && !identity;
    const source = overview ? identities() : identity ? relatedEntries(identity) : details().filter(entry => state.filter === "all" || (state.filter === "independent" ? !linkedIdentities(entry).length : (entry.identityIds || []).includes(state.filter)));
    const visible = source.filter(entry => matches(entry, state.search));
    document.querySelector("#entry-count").textContent = `${visible.length} ${tr(overview ? "identities" : "count")}`;
    const list = document.querySelector("#entry-list");
    list.innerHTML = visible.length ? overview ? visible.map(item => {
        const email = item.fields.find(f => f.id === item.summaryId && !f.sensitive && f.value) || item.fields.find(f => ["email", "workEmail"].includes(f.labelKey) && !f.sensitive && f.value) || item.fields.find(f => !f.sensitive && f.value);
        return `<article class="identity-card"><button type="button" class="identity-card-main" data-action="identity" data-entry="${esc(item.id)}" aria-label="${esc(tr("viewIdentity") + " " + title(item))}">${identityAvatar(item)}<span class="identity-card-text"><strong>${esc(title(item))}</strong><span>${esc(email?.value || tr("identityCustom"))}</span><small>${relatedEntries(item).length} ${tr("linkedCount")}</small></span><span class="entry-chevron" aria-hidden="true">›</span></button>${actionButton("edit", "edit", tr("editIdentity") + " " + title(item), `data-entry="${esc(item.id)}"`)}</article>`;
    }).join("") : visible.map(entryMarkup).join("") : `<div class="empty"><h3>${tr(state.search ? "noResults" : overview ? "identityEmpty" : identity ? "relatedEmpty" : state.filter === "independent" ? "emptyIndependent" : "emptyTitle")}</h3><p>${tr(state.search ? "noResultsBody" : overview ? "identityEmptyHint" : identity ? "relatedEmptyHint" : "emptyBody")}</p><button type="button" class="button secondary" data-action="${state.search ? "clear-search" : overview ? "new-identity" : "new"}">${tr(state.search ? "clearSearch" : overview ? "newIdentity" : "newEntry")}</button></div>`;
}
function removeIdentity(id) {
    state.entries = state.entries.filter(item => item.id !== id);
    details().forEach(entry => entry.identityIds = (entry.identityIds || []).filter(link => link !== id));
}
function identityAction(action, button) {
    const resetView = () => { state.view = "list"; state.search = ""; state.open = null; state.revealed.clear(); render(); content.scrollTop = 0; };
    if (action === "mode") {
        state.mode = button.dataset.mode;
        state.identityId = null;
        state.filter = "all";
        resetView();
    }
    else if (action === "identity") {
        state.mode = "identities";
        state.identityId = button.dataset.entry;
        resetView();
    }
    else if (action === "identity-back") {
        state.identityId = null;
        resetView();
    }
    else if (action === "independent") {
        state.mode = "all";
        state.filter = "independent";
        state.identityId = null;
        resetView();
    }
    else if (action === "new-identity") {
        state.createKind = "identity";
        state.view = "templates";
        render();
        content.scrollTop = 0;
    }
    else if (action === "delete-identity") {
        confirmAction("deleteIdentityTitle", "deleteIdentityBody", "delete", () => {
            removeIdentity(button.dataset.entry);
            state.identityId = null;
            resetView();
        });
    }
    else
        return false;
    return true;
}
