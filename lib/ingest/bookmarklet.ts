/* ────────────────────────────────────────────────────────────────
   The zero-install version of the helper.

   Same job as `public/readloud-helper.user.js`, and the same reason
   for existing: caption URLs need a proof-of-origin token that only
   YouTube's own player mints, so the extraction has to happen on the
   video page. The userscript does it automatically; this does it when
   the reader clicks a bookmark, which costs nothing to set up.

   It is deliberately less defensive than the userscript: it only runs
   when somebody deliberately clicks it while looking at a video, so
   the player response is fresh and the failure modes are visible.
   ──────────────────────────────────────────────────────────────── */

/** Source of the bookmarklet, with `__ORIGIN__` standing in for this app. */
const SOURCE = `
(async function(){
  var O="__ORIGIN__";
  function fail(m){alert("ReadLoud: "+m);}
  try{
    var pr=window.ytInitialPlayerResponse;
    if(!pr||!pr.captions)return fail("open a video page first, then click this again.");
    var ts=pr.captions.playerCaptionsTracklistRenderer.captionTracks||[];
    if(!ts.length)return fail("this video has no captions.");
    var want=(navigator.language||"en").slice(0,2).toLowerCase(),pick=null,i;
    for(i=0;i<ts.length;i++)if(ts[i].kind!=="asr"&&(ts[i].languageCode||"").slice(0,2)===want)pick=pick||ts[i];
    for(i=0;i<ts.length;i++)if((ts[i].languageCode||"").slice(0,2)===want)pick=pick||ts[i];
    pick=pick||ts[0];
    var cues=[],r=await fetch(pick.baseUrl+"&fmt=json3",{credentials:"include"}),b=await r.text();
    if(b){var ev=(JSON.parse(b).events)||[];for(i=0;i<ev.length;i++){var e=ev[i];
      if(e.aAppend===1||!e.segs||typeof e.tStartMs!=="number")continue;
      var t=e.segs.map(function(s){return s.utf8||""}).join("").replace(/\\s+/g," ").trim();
      if(t)cues.push({start:e.tStartMs/1000,end:(e.tStartMs+(e.dDurationMs||0))/1000,text:t});}}
    if(!cues.length){
      var ns=document.querySelectorAll("ytd-transcript-segment-renderer");
      ns.forEach(function(n){var st=n.querySelector(".segment-timestamp"),tx=n.querySelector(".segment-text");
        if(!tx)return;var s=String(st?st.textContent:"").trim().split(":").map(Number),sec=0;
        if(s.length===3)sec=s[0]*3600+s[1]*60+s[2];else if(s.length===2)sec=s[0]*60+s[1];
        var v=(tx.textContent||"").replace(/\\s+/g," ").trim();if(v)cues.push({start:sec,end:0,text:v});});
      for(i=0;i<cues.length;i++)if(!cues[i].end)cues[i].end=cues[i+1]?cues[i+1].start:cues[i].start;
    }
    if(!cues.length)return fail("these captions are locked. Open the transcript panel, select it and paste into ReadLoud.");
    var d=pr.videoDetails||{};
    var j=new TextEncoder().encode(JSON.stringify({v:1,videoId:d.videoId||"",title:d.title||document.title.replace(/ - YouTube$/,""),author:d.author,lang:pick.languageCode,cues:cues}));
    var z=new Uint8Array(await new Response(new Blob([j]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    var bin="";for(i=0;i<z.length;i+=32768)bin+=String.fromCharCode.apply(null,z.subarray(i,i+32768));
    var p=btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
    if(p.length>1500000)return fail("that transcript is too long to hand over. Copy it from the transcript panel instead.");
    window.open(O+"/#yt="+p,"_blank");
  }catch(err){fail((err&&err.message)||"could not read the transcript.");}
})()
`;

/**
 * Build the `javascript:` URL for a given deployment.
 *
 * Whitespace is collapsed because a bookmarklet is one line by definition,
 * and the whole thing is percent-encoded: the payload arithmetic below is
 * full of characters (`#`, `%`, `+`) that a bare href would eat.
 */
export function buildBookmarklet(origin: string): string {
  const code = SOURCE.replace(/__ORIGIN__/g, origin)
    .split("\n")
    .map((l) => l.trim())
    .join("");
  return `javascript:${encodeURIComponent(code)}`;
}
