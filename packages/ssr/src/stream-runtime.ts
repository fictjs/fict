export interface StreamRuntimeCodeOptions {
  /**
   * Enable observer mode so patch templates are applied without per-chunk inline scripts.
   */
  observerMode?: boolean
}

/**
 * Create the browser-side streaming patch runtime as classic-script JavaScript.
 *
 * The generated package asset `@fictjs/ssr/fict-stream-runtime.js` is built from
 * this helper with `observerMode: true`.
 */
export function createStreamRuntimeCode(options: StreamRuntimeCodeOptions = {}): string {
  const observerMode = options.observerMode ?? true
  return (
    '(function(){' +
    'if(window.__FICT_STREAM)return;' +
    'var cache=new Map();' +
    'function find(id){' +
    'var hit=cache.get(id);if(hit)return hit;' +
    'var start=null,end=null;' +
    'var w=document.createTreeWalker(document,NodeFilter.SHOW_COMMENT);' +
    'while(w.nextNode()){' +
    'var n=w.currentNode;var d=n.data;' +
    'if(d==="fict:suspense-start:"+id)start=n;' +
    'else if(d==="fict:suspense-end:"+id)end=n;' +
    'if(start&&end)break;' +
    '}' +
    'if(start&&end){hit={start:start,end:end};cache.set(id,hit);}return hit;' +
    '}' +
    'function apply(id){' +
    "var tpl=document.querySelector('template[data-fict-suspense=\"' + id + '\"]');" +
    'if(!tpl)return;' +
    'var b=find(id);if(!b)return;' +
    'var node=b.start.nextSibling;' +
    'while(node&&node!==b.end){var next=node.nextSibling;node.parentNode&&node.parentNode.removeChild(node);node=next;}' +
    'b.end.parentNode&&b.end.parentNode.insertBefore(tpl.content,b.end);' +
    'tpl.parentNode&&tpl.parentNode.removeChild(tpl);' +
    '}' +
    'window.__FICT_STREAM={apply:apply};' +
    (observerMode
      ? 'function scan(root){var list=(root&&root.querySelectorAll?root:document).querySelectorAll("template[data-fict-suspense]");for(var i=0;i<list.length;i++){apply(list[i].getAttribute("data-fict-suspense"));}}' +
        'if(typeof MutationObserver==="function"){new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){for(var j=0;j<muts[i].addedNodes.length;j++){var n=muts[i].addedNodes[j];if(n.nodeType===1){if(n.matches&&n.matches("template[data-fict-suspense]"))apply(n.getAttribute("data-fict-suspense"));scan(n);}}}}).observe(document.documentElement||document,{childList:true,subtree:true});}' +
        'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){scan(document);},{once:true});}else{scan(document);}'
      : '') +
    '})();'
  )
}

export const FICT_STREAM_RUNTIME_CODE = createStreamRuntimeCode({ observerMode: true })
