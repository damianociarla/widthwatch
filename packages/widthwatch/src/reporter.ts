import type { ComparisonReport, WidthWatchReport } from "./types.js";

export function generateHtmlReport(input: WidthWatchReport | ComparisonReport): string {
  const report = "candidate" in input ? input.candidate : input;
  const comparison = "candidate" in input ? input : null;
  const comparisonState = comparison ? (!comparison.valid ? "comparison invalid" : comparison.passed ? "comparison passed" : "regression found") : "scan complete";
  const statusClass = comparison && (!comparison.valid || !comparison.passed) ? "failed" : "";
  const changedDiffs = comparison?.diffs.filter((diff) => diff.changedPixels > 0).length ?? 0;
  const validationHtml = comparison?.validationErrors.length
    ? `<div class="validation"><strong>Comparison invalid</strong>${comparison.validationErrors.map((error) => `<p>${escapeHtml(error.message)}</p>`).join("")}</div>`
    : "";
  const payload = JSON.stringify({ report, comparison }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WidthWatch · ${escapeHtml(report.title || report.url)}</title>
  <style>
    :root{color-scheme:dark;--ink:#f3f5ef;--muted:#8d9488;--line:#2a3029;--acid:#c6ff3d;--error:#ff5c57;--warn:#ffc85a;--surface:#111410;--panel:#171b16}
    *{box-sizing:border-box}body{margin:0;background:#0a0c09;color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}button,input{font:inherit}
    header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#0a0c09e8;backdrop-filter:blur(14px);z-index:5}
    .brand{font-weight:800;letter-spacing:-.04em;font-size:18px}.brand i{color:var(--acid);font-style:normal}.status{color:var(--muted)}.status b{color:var(--acid)}.status.failed,.status.failed b{color:var(--error)}
    main{display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:calc(100vh - 64px)}.workspace{padding:28px;min-width:0}.inspector{border-left:1px solid var(--line);padding:24px;overflow:auto;max-height:calc(100vh - 64px);position:sticky;top:64px}
    .meta{display:flex;gap:24px;color:var(--muted);margin-bottom:28px;flex-wrap:wrap}.meta strong{color:var(--ink)}
    .timeline{position:relative;height:92px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:24px}.track{position:absolute;left:0;right:0;top:42px;height:2px;background:var(--line)}
    .tick{position:absolute;top:20px;width:36px;height:48px;transform:translateX(-18px);background:transparent;border:0;padding:0;cursor:pointer}.tick:before{content:"";position:absolute;left:17px;top:6px;width:2px;height:34px;background:var(--acid)}.tick.error:before{background:var(--error);height:46px;top:0}.tick.warning:before{background:var(--warn)}.tick:focus-visible{outline:2px solid var(--acid);outline-offset:2px}.tick span{position:absolute;top:42px;left:50%;transform:translateX(-50%);color:var(--muted);font-size:11px;white-space:nowrap}
    .viewer{display:grid;place-items:start center;min-height:560px;overflow:auto;background-color:#0d100c;background-image:linear-gradient(#171b16 1px,transparent 1px),linear-gradient(90deg,#171b16 1px,transparent 1px);background-size:20px 20px;padding:28px}
    .shot-wrap{position:relative;box-shadow:0 20px 70px #0009;transition:width .2s ease}.shot{display:block;width:100%;height:auto}.overlay{position:absolute;border:2px solid var(--error);background:#ff5c5722;pointer-events:none}.overlay.warning{border-color:var(--warn);background:#ffc85a22}
    h1{font:700 26px/1.1 system-ui,sans-serif;letter-spacing:-.04em;margin:0 0 8px}.url{color:var(--muted);word-break:break-all;margin-bottom:28px}.summary{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--line);margin-bottom:24px}.summary div{padding:14px 0}.summary strong{font-size:22px;display:block}.summary span{font-size:11px;color:var(--muted);text-transform:uppercase}.issues{display:grid;gap:1px;background:var(--line)}
    .issue{background:#0a0c09;padding:15px;border:0;color:inherit;text-align:left;cursor:pointer}.issue:hover,.issue.active{background:var(--panel)}.issue small{color:var(--muted)}.issue b{display:block;margin:3px 0}.sev{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--acid);margin-right:7px}.sev.error{background:var(--error)}.sev.warning{background:var(--warn)}
    .empty{color:var(--muted);padding:24px 0}.legend{display:flex;gap:14px;color:var(--muted);font-size:11px;margin-top:10px}.validation{border:1px solid var(--error);background:#ff5c5710;padding:14px;margin-bottom:18px}.validation strong{color:var(--error)}.validation p{color:var(--muted);margin:6px 0 0}.view-tabs{display:flex;gap:1px;margin:0 0 18px;background:var(--line);width:max-content}.view-tabs button{border:0;background:var(--surface);color:var(--muted);padding:9px 14px;cursor:pointer}.view-tabs button.active{background:var(--acid);color:#0a0c09}
    @media(max-width:900px){main{grid-template-columns:1fr}.inspector{position:static;max-height:none;border-left:0;border-top:1px solid var(--line)}.workspace{padding:16px}.viewer{min-height:420px;padding:12px}header{padding:0 16px}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style>
</head>
<body>
<header><div class="brand">width<i>watch</i></div><div class="status ${statusClass}"><b>●</b> ${comparisonState}</div></header>
<main><section class="workspace"><div class="meta"><span>range <strong>${report.range.min}—${report.range.max}px</strong></span><span>samples <strong>${report.frames.length}</strong></span><span>duration <strong>${(report.durationMs / 1000).toFixed(1)}s</strong></span></div>${comparison ? '<div class="view-tabs" id="viewTabs"><button data-view="baseline">Baseline</button><button class="active" data-view="candidate">Candidate</button><button data-view="diff">Diff</button></div>' : ""}<div class="timeline" id="timeline"><div class="track"></div></div><div class="viewer"><div class="shot-wrap" id="shotWrap"><img class="shot" id="shot" alt="Responsive capture"><div id="overlays"></div></div></div><div class="legend"><span>● sampled width</span><span>● issue detected</span></div></section>
<aside class="inspector"><h1>${escapeHtml(report.title || "Untitled page")}</h1><div class="url">${escapeHtml(report.url)}</div><div class="summary"><div><strong>${comparison?.regressions.length ?? report.summary.errors}</strong><span>${comparison ? "regressions" : "errors"}</span></div><div><strong>${comparison?.validationErrors.length ?? report.summary.warnings}</strong><span>${comparison ? "invalid" : "warnings"}</span></div><div><strong>${comparison ? changedDiffs : report.summary.sampledWidths}</strong><span>${comparison ? "changed" : "frames"}</span></div></div>${validationHtml}<div class="issues" id="issues"></div></aside></main>
<script>const DATA=${payload};
const report=DATA.report, comparison=DATA.comparison, timeline=document.querySelector('#timeline'), shot=document.querySelector('#shot'), shotWrap=document.querySelector('#shotWrap'), issues=document.querySelector('#issues'), overlays=document.querySelector('#overlays');let selected=0,view='candidate';
function severity(frame){return frame.issues.some(i=>i.severity==='error')?'error':frame.issues.some(i=>i.severity==='warning')?'warning':''}
function visualFrame(frame){if(!comparison||view==='candidate')return frame;if(view==='baseline')return comparison.baseline.frames.find(item=>item.width===frame.width)||frame;const diff=comparison.diffs.find(item=>item.width===frame.width);return diff&&diff.diffScreenshot?{...frame,screenshot:diff.diffScreenshot,issues:comparison.regressions.filter(item=>item.width===frame.width)}:{...frame,issues:comparison.regressions.filter(item=>item.width===frame.width)}}
function render(index){selected=index;const candidate=report.frames[index],frame=visualFrame(candidate);shot.src=frame.screenshot;shot.alt=(view==='candidate'?'Candidate':view[0].toUpperCase()+view.slice(1))+' capture at '+frame.width+' pixels';shotWrap.style.width=Math.min(frame.width,shotWrap.parentElement.clientWidth-24)+'px';document.querySelectorAll('.tick').forEach((el,i)=>el.style.opacity=i===index?'1':'.45');issues.innerHTML='';overlays.innerHTML='';if(!frame.issues.length){issues.innerHTML='<div class="empty">No deterministic issues at this width.</div>'}
frame.issues.forEach((item,itemIndex)=>{const button=document.createElement('button');button.className='issue'+(itemIndex===0?' active':'');button.innerHTML='<small><i class="sev '+item.severity+'"></i>'+item.width+'px · '+item.kind+'</small><b>'+escapeText(item.message)+'</b><small>'+escapeText(item.elements.map(e=>e.selector).join(' · '))+'</small>';button.onclick=()=>{document.querySelectorAll('.issue').forEach(el=>el.classList.remove('active'));button.classList.add('active');draw(item,frame)};issues.append(button)});if(frame.issues[0])draw(frame.issues[0],frame)}
function draw(item,frame){overlays.innerHTML='';const scale=shot.clientWidth/frame.width;item.elements.forEach(element=>{const box=document.createElement('div');box.className='overlay '+item.severity;Object.assign(box.style,{left:element.rect.x*scale+'px',top:element.rect.y*scale+'px',width:element.rect.width*scale+'px',height:element.rect.height*scale+'px'});overlays.append(box)})}
function escapeText(value){const el=document.createElement('span');el.textContent=value;return el.innerHTML}
report.frames.forEach((frame,index)=>{const tick=document.createElement('button');tick.className='tick '+severity(frame);tick.style.left=((frame.width-report.range.min)/Math.max(1,report.range.max-report.range.min)*100)+'%';tick.setAttribute('aria-label','Show '+frame.width+' pixel capture');tick.innerHTML='<span>'+frame.width+'</span>';tick.onclick=()=>render(index);timeline.append(tick)});document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(item=>item.classList.toggle('active',item===button));render(selected)});render(0);addEventListener('resize',()=>render(selected));</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
