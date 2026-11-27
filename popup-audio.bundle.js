(()=>{var w={off:{normalizer:0,dialogue:0,bass:0,treble:0},standard:{normalizer:1,dialogue:0,bass:0,treble:0},cinema:{normalizer:1,dialogue:3,bass:2,treble:1},dialogue:{normalizer:3,dialogue:6,bass:-3,treble:0},night:{normalizer:4,dialogue:4,bass:-4,treble:0},music:{normalizer:0,dialogue:0,bass:0,treble:0}},K={off:"Off",standard:"Standard",cinema:"Cinema",dialogue:"Dialogue",night:"Night",music:"Music",custom:"Custom"},ue=["Off","Light","Medium","Strong","Night"];var Xe=Math.pow(10,-1/20);var N=(e,t,s)=>e<t?t:e>s?s:e;var le=(e,t)=>!!e&&typeof e=="object"&&Object.prototype.hasOwnProperty.call(e,t);function $(e,t){return le(e&&e.presets,t)&&e.presets[t]&&typeof e.presets[t]=="object"?e.presets[t]:le(w,t)?w[t]:w.off}function U(e={}){let t=e.edits&&typeof e.edits=="object"?e.edits:e.preset==="custom"?e.custom:null,s=t?{...w.off,...t}:$(e,e.preset);return{normalizer:N(Math.round(+s.normalizer||0),0,4),dialogue:N(+s.dialogue||0,0,12),bass:N(+s.bass||0,-12,12),treble:N(+s.treble||0,-12,12),mono:!!e.mono,boost:N(+e.boost||1,1,2)}}function V(e){return!e.normalizer&&!e.dialogue&&!e.bass&&!e.treble&&!e.mono&&e.boost<=1}var ze=["off","standard","cinema","dialogue","night","music"],de=["normalizer","dialogue","bass","treble"],j=30;var Ie={normalizer:[0,4],dialogue:[0,12],bass:[-12,12],treble:[-12,12]},A=(e,t)=>!!e&&Object.prototype.hasOwnProperty.call(e,t),Q=e=>A(w,e),x=e=>typeof e=="string"&&/^u[a-z0-9]{1,20}$/.test(e);function q(e){let t={};for(let s of de){let[i,c]=Ie[s],p=+(e&&e[s])||0;t[s]=Math.min(c,Math.max(i,s==="normalizer"?Math.round(p):p))}return t}var H=(e,t)=>de.every(s=>(+e[s]||0)==(+t[s]||0)),R=e=>String(e??"").replace(/\s+/g," ").trim().slice(0,j);function v(e){let t=e&&typeof e=="object"?e:{},s={};if(t.presets&&typeof t.presets=="object"){for(let[p,d]of Object.entries(t.presets))if(!(!d||typeof d!="object")){if(Q(p)&&p!=="off"){let S=q(d);H(S,w[p])||(s[p]=S)}else if(x(p)){let S=R(d.name);S&&(s[p]={name:S,...q(d)})}}}let i=typeof t.preset=="string"?t.preset:"off",c=t.edits&&typeof t.edits=="object"?q(t.edits):null;return i==="custom"&&!c&&t.custom&&typeof t.custom=="object"&&(c=q(t.custom)),i!=="custom"&&!Q(i)&&!A(s,i)&&(i=c?"custom":"off"),i==="off"&&c&&(i="custom"),i==="custom"&&(!c||H(c,w.off))&&(i="off",c=null),c&&i!=="custom"&&H(c,$({presets:s},i))&&(c=null),{preset:i,boost:Math.min(2,Math.max(1,Math.round((+t.boost||1)*100)/100)),mono:!!t.mono,edits:c,presets:s}}var G=e=>q(e.edits||$(e,e.preset));function P(e,t){return x(t)&&A(e.presets,t)?e.presets[t].name:K[t]||t}var W=e=>P(e,e.preset)+(e.edits?"*":""),Y=(e,t)=>Q(t)&&A(e.presets,t);function J(e){return[...ze.map(t=>({id:t,name:K[t],user:!1})),...Object.keys(e.presets).filter(x).map(t=>({id:t,name:e.presets[t].name,user:!0}))]}var X=e=>({preset:e,edits:null});function pe(e,t,s){return{preset:e.preset,edits:{...G(e),[t]:s}}}function he(e){if(!e.edits||e.preset==="custom"||e.preset==="off")return{};let t=x(e.preset)?{name:e.presets[e.preset].name}:{};return{presets:{...e.presets,[e.preset]:{...t,...e.edits}},edits:null}}function Z(e,t,s=null){let i=R(t).toLowerCase();return i?i==="custom"||J(e).some(c=>c.id!==s&&c.name.toLowerCase()===i)?"That name is already used":"":"Enter a name"}function fe(e){let t=e.preset==="custom"||e.preset==="off"?"My preset":P(e,e.preset);for(let s=e.preset==="custom"||e.preset==="off"?1:2;;s++){let i=`${t.slice(0,j-4)} ${s}`;if(!Z(e,i))return i}}function me(e,t,s=Fe(e)){return{presets:{...e.presets,[s]:{name:R(t),...G(e)}},preset:s,edits:null}}function Fe(e){let t;do t=`u${Date.now().toString(36)}${Math.floor(Math.random()*1296).toString(36)}`;while(A(e.presets,t));return t}function be(e,t,s){return!x(t)||!A(e.presets,t)?{}:{presets:{...e.presets,[t]:{...e.presets[t],name:R(s)}}}}function ge(e,t){let s={...e.presets};return delete s[t],e.preset===t?{presets:s,preset:"custom",edits:G(e)}:{presets:s}}function ye(e,t){let s={...e.presets};return delete s[t],e.preset===t?{presets:s,edits:null}:{presets:s}}var $e={off:"No processing",standard:"Evens out loud and quiet parts gently",cinema:"Keeps the impact, softens the extremes, clearer voices",dialogue:"Quiet voices lifted, loud scenes tamed",night:"Strongest leveling for low-volume listening",music:"Volume boost only"};var D=(e,t=" dB")=>`${e>0?"+":e<0?"\u2212":""}${Math.abs(Math.round(e*10)/10)}${t}`;function je(e){let t=P(e,e.preset);return e.preset==="custom"?"Your own settings \xB7 not saved":e.edits?`Changed from ${t} \xB7 not saved`:x(e.preset)?"Your preset":Y(e,e.preset)?`Your version of ${t}`:$e[e.preset]||""}function Re(e,t){let s=P(e,e.preset);return e.preset==="custom"?[["new","Save as preset\u2026"]]:e.edits?[["save",`Save to \u201C${s}\u201D`],["new","Save as new\u2026"],["reset","Reset"]]:x(e.preset)?[["rename","Rename"],["delete",t===e.preset?`Delete \u201C${s}\u201D?`:"Delete"]]:Y(e,e.preset)?[["restore","Restore default"]]:[]}function we(e,{fx:t,unreadableText:s="Starts once the file is loaded"}){e.setAttribute("aria-label","Audio effects"),e.innerHTML=`
    <div class="sap-audio-head"><strong>Audio</strong><span class="sap-audio-status" aria-live="polite"></span></div>
    <div class="sap-audio-presets" role="radiogroup" aria-label="Preset"></div>
    <p class="sap-audio-hint" aria-live="polite"></p>
    <div class="sap-audio-actions" hidden></div>
    <div class="sap-audio-name" hidden>
      <div class="sap-audio-name-row">
        <input type="text" class="sap-audio-name-input" maxlength="${j}" autocomplete="off" spellcheck="false" enterkeyhint="done" aria-label="Preset name">
        <button type="button" class="sap-audio-act sap-audio-primary" data-act="name-ok">Save</button>
        <button type="button" class="sap-audio-act" data-act="name-cancel">Cancel</button>
      </div>
      <p class="sap-audio-error" aria-live="assertive"></p>
    </div>
    <label class="sap-audio-row"><span>Volume boost <output data-for="boost"></output></span>
      <input type="range" data-key="boost" min="100" max="200" step="5"></label>
    <label class="sap-audio-row"><span>Normalizer <output data-for="normalizer"></output></span>
      <input type="range" data-key="normalizer" min="0" max="4" step="1"></label>
    <label class="sap-audio-row"><span>Dialogue boost <output data-for="dialogue"></output></span>
      <input type="range" data-key="dialogue" min="0" max="12" step="1"></label>
    <label class="sap-audio-row"><span>Bass <output data-for="bass"></output></span>
      <input type="range" data-key="bass" min="-8" max="8" step="1"></label>
    <label class="sap-audio-row"><span>Treble <output data-for="treble"></output></span>
      <input type="range" data-key="treble" min="-8" max="8" step="1"></label>
    <label class="sap-audio-check"><input type="checkbox" data-key="mono"> Mono (one earbud)</label>`;let i=e.querySelector(".sap-audio-presets"),c=e.querySelector(".sap-audio-status"),p=e.querySelector(".sap-audio-hint"),d=e.querySelector(".sap-audio-actions"),S=e.querySelector(".sap-audio-name"),f=e.querySelector(".sap-audio-name-input"),se=e.querySelector('[data-act="name-ok"]'),Ce=e.querySelector(".sap-audio-error"),F=Object.fromEntries([...e.querySelectorAll("[data-key]")].map(n=>[n.dataset.key,n])),C=Object.fromEntries([...e.querySelectorAll("output[data-for]")].map(n=>[n.dataset.for,n])),ne="",oe="",l=null,b=null,ae=0,Te=n=>{let o=i.querySelector(`[data-preset="${CSS.escape(n)}"]`);o&&o.focus()},re=n=>{let o=d.querySelector(`[data-act="${n}"]`);return o&&!d.hidden?(o.focus(),!0):!1},T=(n,o)=>{t.set(n),E(),o&&Te(o)};function Le({id:n,name:o}){let a=document.createElement("button");return a.type="button",a.className="sap-audio-preset",a.dataset.preset=n,a.dataset.name=o,a.title=o,a.setAttribute("role","radio"),a.addEventListener("click",()=>{n!==t.settings.preset&&(_(),t.setPreset(n),E())}),a}for(let[n,o]of Object.entries(F))o.addEventListener("input",()=>{if(n==="boost")return t.set({boost:+o.value/100});if(n==="mono")return t.set({mono:o.checked});t.set(pe(t.settings,n,+o.value))});d.addEventListener("click",n=>{let o=n.target.closest("[data-act]");if(!o)return;let a=t.settings,r=o.dataset.act;if(r==="new"||r==="rename")return Ne(r,a.preset);if(r==="delete"&&b!==a.preset)return b=a.preset,clearTimeout(ae),ae=setTimeout(()=>{b=null,E()},4e3),E();b=null,r==="save"?T(he(a),a.preset):r==="reset"?T({edits:null},a.preset):r==="restore"?T(ye(a,a.preset),a.preset):r==="delete"&&T(ge(a,a.preset),t.settings.preset)});function L(n){Ce.textContent=n,f.setAttribute("aria-invalid",String(!!n))}function Ne(n,o){l={mode:n,id:o},se.textContent=n==="rename"?"Rename":"Save",f.value=n==="rename"?P(t.settings,o):fe(t.settings),L(""),E(),f.focus(),f.select()}function _({refocus:n=!1}={}){l&&(l=null,L(""),E(),n&&!re("new")&&re("rename"))}function ie(){if(!l)return;let n=t.settings,o=l.mode==="rename",a=Z(n,f.value,o?l.id:null);if(a){L(a),f.focus();return}let r=o?be(n,l.id,f.value):me(n,f.value),u=o?l.id:r.preset;l=null,L(""),T(r,u)}f.addEventListener("input",()=>L("")),f.addEventListener("keydown",n=>{n.key==="Enter"?(n.preventDefault(),ie()):n.key==="Escape"&&(n.preventDefault(),n.stopPropagation(),_({refocus:!0}))}),se.addEventListener("click",()=>ie()),e.querySelector('[data-act="name-cancel"]').addEventListener("click",()=>_({refocus:!0}));function qe(n){if(n.text)return n.text;if(n.mode==="waiting")return"Starts when you tap the video";if(n.mode==="unreadable")return s;if(n.mode==="error")return"Unavailable";if(!n.wanted)return"";let o=n.state;if(!o)return n.mode==="active"?"On":"";let a=[];return n.params.normalizer&&a.push(`Leveler ${D(o.levelerDb+o.compressorDb)}`),o.limiterDb<-.5&&a.push(`Limiter ${D(o.limiterDb)}`),o.channels>=6&&a.push("5.1 source"),a.join(" \xB7 ")||"On"}function De(n){let o=J(n);n.preset==="custom"&&o.push({id:"custom",name:"Custom"});let a=JSON.stringify(o);a!==ne&&(ne=a,i.replaceChildren(...o.map(Le)));for(let r of i.children){let u=r.dataset.preset===n.preset,k=u&&!!n.edits;r.setAttribute("aria-checked",String(u)),r.dataset.changed=String(k),r.textContent=r.dataset.name+(k?"*":""),k?r.setAttribute("aria-label",`${r.dataset.name} (changed, not saved)`):r.removeAttribute("aria-label")}}function Oe(n){l&&l.mode==="rename"&&!Object.prototype.hasOwnProperty.call(n.presets,l.id)&&(l=null),b&&b!==n.preset&&(b=null);let o=l?[]:Re(n,b),a=o.map(r=>r[0]).join();a!==oe&&(oe=a,d.replaceChildren(...o.map(([r])=>{let u=document.createElement("button");return u.type="button",u.className=`sap-audio-act${r==="save"?" sap-audio-primary":""}`,u.dataset.act=r,u}))),o.forEach(([r,u],k)=>{let ce=d.children[k];ce.textContent=u,ce.dataset.confirm=String(r==="delete"&&b===n.preset)}),d.hidden=!o.length,S.hidden=!l}function E(n=t.status()){let o=n.params;De(n.settings),Oe(n.settings),p.textContent=je(n.settings),c.textContent=qe(n);let a=document.activeElement,r=(u,k)=>{F[u]!==a&&(F[u].value=String(k))};r("boost",Math.round(o.boost*100)),r("normalizer",o.normalizer),r("dialogue",o.dialogue),r("bass",o.bass),r("treble",o.treble),F.mono.checked=o.mono,C.boost.textContent=`${Math.round(o.boost*100)}%`,C.normalizer.textContent=ue[o.normalizer],C.dialogue.textContent=o.dialogue?D(o.dialogue):"Off",C.bass.textContent=D(o.bass),C.treble.textContent=D(o.treble)}return{render:E}}var M="audioFx",Be=()=>{let e=globalThis.browser||globalThis.chrome;return e&&e.storage&&e.storage.local?e:null};async function xe(){let e=Be();if(!e)return v();try{let t=await e.storage.local.get(M);return v(t&&t[M])}catch{return v()}}var ve=`/* Audio effects control (src/audio-ui.mjs): a button in each player's control bar and a panel
   above it; a small dot on the icon shows that effects are on (blue: waiting to start). */
.sap-audio { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.sap-audio .sap-audio-btn {
  width: 40px;
  height: 40px;
  padding: 6px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sap-audio .sap-audio-btn:hover, .sap-audio .sap-audio-btn:focus-visible { background: rgba(255, 255, 255, 0.12); outline: none; }
.sap-audio svg { width: 28px; height: 28px; }
.sap-audio svg path { fill: none !important; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.sap-audio svg .sap-audio-dot { fill: #4caf50 !important; stroke: none; display: none; }
.sap-audio[data-active="on"] svg .sap-audio-dot { display: inline; }
.sap-audio[data-active="pending"] svg .sap-audio-dot { display: inline; fill: #64b5f6 !important; }

.sap-audio-menu {
  position: absolute;
  z-index: 2147483000;
  box-sizing: border-box;
  width: min(340px, calc(100% - 16px));
  max-height: calc(100% - 72px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  border-radius: 10px;
  background: rgba(20, 20, 28, 0.95);
  color: #fff;
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.sap-audio-menu[hidden], .sap-audio-menu [hidden] { display: none; }
.sap-audio-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sap-audio-head strong { font-size: 14px; }
.sap-audio-status { color: #a5d6a7; font-size: 12px; text-align: right; }
.sap-audio-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.sap-audio-preset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 16px;
  background: transparent;
  color: #fff;
  font: inherit;
  cursor: pointer;
}
.sap-audio-preset:hover { background: rgba(255, 255, 255, 0.1); }
.sap-audio-preset[aria-checked="true"] { background: #4caf50; border-color: #4caf50; font-weight: 600; }
.sap-audio-preset { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* selected with unsaved changes ("Cinema*") */
.sap-audio-preset[data-changed="true"] { border-style: dashed; border-color: #e8f5e9; }
.sap-audio-preset:focus-visible, .sap-audio-act:focus-visible { outline: 2px solid #90caf9; outline-offset: 2px; }
/* Save to / Save as new / Reset, Rename / Delete, Restore default; the name field */
.sap-audio-actions, .sap-audio-name-row { display: flex; flex-wrap: wrap; gap: 6px; }
.sap-audio-act {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sap-audio-act:hover { background: rgba(255, 255, 255, 0.16); }
.sap-audio-act.sap-audio-primary { background: #4caf50; border-color: #4caf50; font-weight: 600; }
.sap-audio-act[data-confirm="true"] { background: #e53935; border-color: #e53935; font-weight: 600; }
.sap-audio-name { display: flex; flex-direction: column; gap: 4px; }
.sap-audio-name-input {
  flex: 1 1 140px;
  min-width: 0;
  min-height: 30px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font: inherit;
}
.sap-audio-name-input:focus { outline: none; border-color: #90caf9; }
.sap-audio-name-input[aria-invalid="true"] { border-color: #ef5350; }
.sap-audio-error { margin: 0; color: #ef9a9a; font-size: 12px; }
.sap-audio-error:empty { display: none; }
.sap-audio-hint { margin: 0; color: rgba(255, 255, 255, 0.7); font-size: 12px; min-height: 16px; }
.sap-audio-row { display: flex; flex-direction: column; gap: 2px; }
.sap-audio-row span { display: flex; justify-content: space-between; color: rgba(255, 255, 255, 0.9); }
.sap-audio-row output { color: #fff; font-variant-numeric: tabular-nums; font-weight: 600; }
.sap-audio-row input[type="range"] { width: 100%; margin: 0; height: 24px; accent-color: #4caf50; cursor: pointer; }
.sap-audio-check { display: flex; align-items: center; gap: 8px; min-height: 28px; cursor: pointer; }
.sap-audio-check input { width: 18px; height: 18px; margin: 0; accent-color: #4caf50; }
@media (pointer: coarse) {
  .sap-audio .sap-audio-btn { width: 44px; height: 44px; }
  .sap-audio-preset { min-height: 44px; padding: 0 14px; border-radius: 22px; }
  .sap-audio-act, .sap-audio-name-input { min-height: 44px; font-size: 14px; }
  .sap-audio-act { padding: 0 14px; }
  .sap-audio-row input[type="range"] { height: 44px; }
  .sap-audio-check { min-height: 44px; }
  .sap-audio-check input { width: 24px; height: 24px; }
}
`;var y=globalThis.browser||globalThis.chrome,Se=!!(globalThis.chrome&&chrome.tabCapture&&chrome.tabCapture.getMediaStreamId),Ee=document.createElement("style");Ee.textContent=`${ve}
.sap-audio-menu.sap-audio-inline { position: static; width: auto; max-height: none; overflow: visible; padding: 12px 0 4px; background: none; box-shadow: none; }
.audio-capture { margin-top: 8px; }
.audio-capture .save-btn { width: 100%; }`;document.head.appendChild(Ee);var Ke=document.getElementById("audio-panel"),Ue=document.getElementById("panel-audio"),Ve=document.getElementById("audio-capture"),ke=document.getElementById("audio-capture-text"),B=document.getElementById("audio-capture-btn"),m=v(),z=!1,g=null,h={reachable:!1,frames:[],audible:!1,captured:!1},Pe="",Me=0,ee=new Set,O=()=>{for(let e of ee)e(I.status())};function Ae(e){let t=e.filter(s=>s.mode!=="none");return t.find(s=>s.playing)||t[0]||null}function He(e){return z?h.captured?"Whole tab processed":h.reachable?e?e.mode==="loading"?"Preparing the video\u2026":e.mode==="unreadable"?e.drm?"DRM-protected: the page's audio can't be processed":e.noCors?"This video's server refuses it":"Starts once the video loads":e.mode==="error"?"This site processes its own audio":"":h.audible?"The audio on this tab is not from a video or audio element":"Nothing playing on this tab":"Effects can't run on this page":"Off on websites: only the built-in players use these settings"}var I={get settings(){return m},status(){let e=U(m),t=!V(e),s=Ae(h.frames),i=t||!z?He(s):"";return{mode:s?s.mode:"none",settings:m,params:e,wanted:t,active:!!s&&s.mode==="active",presetName:W(m),state:s&&s.mode==="active"?s.state:null,text:i}},set(e){m=v({...m,...e}),clearTimeout(Me),Me=setTimeout(()=>{Pe=JSON.stringify(m),y.storage.local.set({[M]:m}).catch(()=>{})},150),O()},setPreset(e){I.set(X(e))},report(){},subscribe(e){return ee.add(e),()=>ee.delete(e)}},Qe=we(Ke,{fx:I});I.subscribe(e=>{Qe.render(e),Ge()});function Ge(){let e=Ae(h.frames),t=!!e&&(e.drm||e.noCors||e.mode==="error"),s=Se&&z&&g!=null&&(h.captured||I.status().wanted&&(t||!e&&h.audible));Ve.hidden=!s,s&&(B.textContent=h.captured?"Stop processing whole tab":"Process whole tab",ke.textContent=h.captured?"The tab's whole sound goes through the effects; Chrome shows that the tab is shared.":"Runs the tab's whole sound through the effects instead. Chrome shows that the tab is shared while this is on.")}B.addEventListener("click",async()=>{B.disabled=!0;try{if(h.captured)await y.runtime.sendMessage({type:"audioCaptureStop",tabId:g});else{let e=await new Promise((s,i)=>{chrome.tabCapture.getMediaStreamId({targetTabId:g},c=>{chrome.runtime.lastError||!c?i(new Error((chrome.runtime.lastError||{}).message||"No stream")):s(c)})}),t=await y.runtime.sendMessage({type:"audioCaptureStart",tabId:g,streamId:e});if(!t||!t.ok)throw new Error(t&&t.error||"Capture failed")}}catch(e){ke.textContent=`Could not process the tab: ${e.message}`}finally{B.disabled=!1,te()}});async function te(){if(g==null)return;let e={reachable:!1,frames:[],audible:!1,captured:!1};try{let t=await y.scripting.executeScript({target:{tabId:g,allFrames:!0},func:()=>{let s=globalThis.__sapAudio;return s?(s.report(),s.status()):null}});e.reachable=!0,e.frames=t.map(s=>s&&s.result).filter(Boolean)}catch{}try{e.audible=!!(await y.tabs.get(g)).audible}catch{}Se&&(e.captured=!!(await y.runtime.sendMessage({type:"audioCaptureState",tabId:g}).catch(()=>null)||{}).captured),h=e,O()}async function We(){let e=parseInt(new URLSearchParams(location.search).get("tabId"),10);if(Number.isInteger(e))return e;let[t]=await y.tabs.query({active:!0,currentWindow:!0});return t?t.id:null}async function Ye(){let[e,t,s]=await Promise.all([xe(),y.storage.local.get("settings").then(i=>i&&i.settings||{},()=>({})),We().catch(()=>null)]);m=e,z=!!t.webAudioFx,g=s,O(),te(),setInterval(()=>{Ue.hidden||te()},500)}y.storage.onChanged.addListener((e,t)=>{t==="local"&&(e[M]&&e[M].newValue&&JSON.stringify(e[M].newValue)!==Pe&&(m=v(e[M].newValue),O()),e.settings&&(z=!!(e.settings.newValue||{}).webAudioFx,O()))});Ye();})();
