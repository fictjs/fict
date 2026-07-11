export interface StreamRuntimeCodeOptions {
  /**
   * Enable observer mode so patch templates are applied without per-chunk inline scripts.
   * Existing template fragments are covered by the initial scan; observation follows
   * additions to the document tree made while streamed HTML is parsed.
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
    'function walk(root,visit){' +
    'var stack=[root];while(stack.length){' +
    'var node=stack.pop();if(visit(node)===false)return false;' +
    'var container=node.nodeType===1&&node.localName==="template"&&node.content?node.content:node;' +
    'for(var child=container.lastChild;child;child=child.previousSibling)stack.push(child);' +
    '}return true;' +
    '}' +
    'function findTemplate(id){' +
    'var tpl=null;walk(document,function(n){' +
    'if(n.nodeType===1&&n.localName==="template"&&n.content&&n.getAttribute("data-fict-suspense")===id){tpl=n;return false;}' +
    '});return tpl;' +
    '}' +
    'function find(id){' +
    'var hit=cache.get(id);if(hit)return hit;' +
    'var startMarker="fict:suspense-start:"+id,endMarker="fict:suspense-end:"+id;' +
    'walk(document,function(n){' +
    'if(n.nodeType!==8||n.data!==startMarker)return;' +
    'var end=n.nextSibling;while(end&&(end.nodeType!==8||end.data!==endMarker))end=end.nextSibling;' +
    'if(end){hit={start:n,end:end};return false;}' +
    '});' +
    'if(hit)cache.set(id,hit);return hit;' +
    '}' +
    'function apply(id){' +
    'if(typeof id!=="string"||!id)return;' +
    'var tpl=findTemplate(id);if(!tpl)return;' +
    'var b=find(id);if(!b)return;' +
    'var parent=b.start.parentNode;if(!parent||b.end.parentNode!==parent)return;' +
    'var cursor=b.start.nextSibling;while(cursor&&cursor!==b.end)cursor=cursor.nextSibling;if(cursor!==b.end)return;' +
    'var content=tpl.content;var ns=tpl.getAttribute("data-fict-patch-namespace");' +
    'if(ns){var tag=ns==="svg"?"svg":ns==="mathml"?"math":null;var wrapper=content.firstElementChild;if(!tag||!wrapper||wrapper.localName!==tag)return;var fragment=document.createDocumentFragment();while(wrapper.firstChild)fragment.appendChild(wrapper.firstChild);content=fragment;}' +
    'var node=b.start.nextSibling;' +
    'while(node&&node!==b.end){var next=node.nextSibling;node.parentNode&&node.parentNode.removeChild(node);node=next;}' +
    'parent.insertBefore(content,b.end);' +
    'tpl.parentNode&&tpl.parentNode.removeChild(tpl);' +
    '}' +
    'window.__FICT_STREAM={apply:apply};' +
    (observerMode
      ? 'function scan(root){var ids=[];walk(root,function(n){if(n.nodeType===1&&n.localName==="template"&&n.content&&n.hasAttribute("data-fict-suspense")){var id=n.getAttribute("data-fict-suspense");if(id)ids.push(id);}});for(var i=0;i<ids.length;i++)apply(ids[i]);}' +
        'if(typeof MutationObserver==="function"){new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){for(var j=0;j<muts[i].addedNodes.length;j++){var n=muts[i].addedNodes[j];if(n.nodeType===1)scan(n);}}}).observe(document.documentElement||document,{childList:true,subtree:true});}' +
        'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){scan(document);},{once:true});}else{scan(document);}'
      : '') +
    '})();'
  )
}

export const FICT_STREAM_RUNTIME_CODE = createStreamRuntimeCode({ observerMode: true })
