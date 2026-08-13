(function(){
const I=window.ICONS,D=window.DATA,T=window.TONES;
const tone=i=>`background:var(--tone-${T[i%8]});border-color:var(--tone-${T[i%8]}-b)`;
const cov=(i,cls)=>`<div class="${cls||'cov'}" style="${tone(i)}">${I.note}</div>`;
const art=(i,cls,ico)=>`<div class="${cls}" style="${tone(i)}">${I[ico||'disc']}</div>`;
const head=(title,sub,right)=>`<div class="viewhead"><div><h1>${title}</h1>${sub?`<div class="sub">${sub}</div>`:''}</div>${right||''}</div>`;
const top=(label,route)=>`<div class="topbar"><button class="iconbtn back" data-nav="${route}">${I.back}</button><span class="sp"></span><button class="iconbtn">${I.more}</button></div>`;
const trkRow=(t,i,extra)=>`<button class="trk" data-play="${t.t}" data-i="${i}">${cov(i)}<div class="info"><div class="tt">${t.t}</div><div class="ts">${t.a} · ${t.al}</div></div><div class="dur">${extra||t.d}</div></button>`;
const secHead=(l,link)=>`<div class="sec-head"><div class="eyebrow">${l}</div>${link?`<a href="#" data-nav="${link[1]}">${link[0]} →</a>`:''}</div>`;

const S={};
S.home=()=>`<div class="screen">${head('Home','1,746 tracks · 12 albums',`<div style="display:flex;gap:2px"><button class="iconbtn" data-nav="queue">${I.queue}</button><button class="iconbtn" data-nav="settings">${I.settings}</button></div>`)}
<div class="qs-row">
<button class="qs" data-play="Shuffle"><div class="eyebrow" style="color:var(--accent)">Quick start</div><h3>Shuffle all</h3><div class="meta">1,746 tracks</div></button>
<button class="qs" data-nav="stations"><div class="eyebrow">Station</div><h3>Neighbors radio</h3><div class="meta">seeded by J. Cole</div></button>
<button class="qs" data-nav="crate"><div class="eyebrow">Crate</div><h3>Unsorted</h3><div class="meta">34 tracks waiting</div></button></div>
<div class="sec">${secHead('Recently played',['View history','history'])}<div class="card" style="padding:2px 12px">${D.tracks.slice(0,5).map((t,i)=>trkRow(t,i,t.ago+' ago')).join('')}</div></div>
<div class="sec">${secHead('Based on your favorites',['View all','library'])}<div class="grid">${D.albums.slice(0,4).map((a,i)=>`<button class="alb" data-nav="album" style="background:none;border:0;padding:0;text-align:left;color:inherit">${art(i+3,'art')}<div class="t">${a.t}</div><div class="s">${a.a}</div></button>`).join('')}</div></div>
<div class="sec">${secHead('Genres')}<div class="chiprow" style="padding-left:0;padding-right:0">${['Hip hop','Neo-soul','Jazz rap','Ambient','Funk','Experimental'].map(g=>`<span class="chip">${g}</span>`).join('')}</div></div>
<div style="height:10px"></div></div>`;

S.library=()=>`<div class="screen">${head('Library','1,746 tracks · 12 albums · 47 genres')}
<div class="chiprow">${['Albums','Artists','Playlists','Tracks','Folders','Genres'].map((c,i)=>`<span class="chip"${i===0?' data-on':''}>${c}</span>`).join('')}</div>
<div class="sec"><div class="grid">${D.albums.map((a,i)=>`<button class="alb" data-nav="album" style="background:none;border:0;padding:0;text-align:left;color:inherit">${art(i,'art')}<div class="t">${a.t}</div><div class="s">${a.a} · ${a.y}</div></button>`).join('')}</div></div>
<div class="sec">${secHead('Artists')}</div><div class="rowlist">${D.artists.slice(0,4).map((a,i)=>`<button class="rowitem" data-nav="artist">${art(i+2,'cov','person')}<div style="flex:1"><div class="rt">${a.n}</div><div class="ts" style="font-size:11.5px;color:var(--t3);margin-top:2px">${a.al} albums · ${a.tr} tracks</div></div>${I.chev.replace('class="icon"','class="icon chev"')}</button>`).join('')}</div>
<div class="sec">${secHead('Collections')}<div class="rowlist">${[['Playlists','playlists','note','4 lists'],['Stations','stations','radio','3 saved'],['Queue','queue','queue','8 tracks'],['History','history','history','1,204 plays']].map(r=>`<button class="rowitem" data-nav="${r[1]}" style="padding-left:0;padding-right:0">${I[r[2]].replace('class="icon"','class="icon lead"')}<div class="rt">${r[0]}</div><div class="rv">${r[3]}</div>${I.chev.replace('class="icon"','class="icon chev"')}</button>`).join('')}</div></div>
<div class="sec" style="margin-top:22px">${secHead('Playlists',['View all','playlists'])}</div>
<div class="rowlist">${D.playlists.slice(0,3).map((p,i)=>`<button class="rowitem" data-nav="playlist">${art(i+1,'cov','note')}<div style="flex:1"><div class="rt">${p.n}</div><div class="ts" style="font-size:11.5px;color:var(--t3);margin-top:2px">${p.c} tracks</div></div>${I.chev.replace('class="icon"','class="icon chev"')}</button>`).join('')}</div>
<div style="height:14px"></div></div>`;

S.album=()=>{const a=D.albums[0];return `<div class="screen">${top('Library','library')}
<div class="hero">${art(0,'art')}<div><h1>${a.t}</h1><div class="by">${a.a}</div><div class="meta">${a.y} · ${a.n} tracks · 58 min</div></div></div>
<div class="actions"><button class="btn btn--pri" data-play="${D.tracks[2].t}">${I.play}Play</button><button class="btn">${I.shuffle}Shuffle</button><button class="btn btn--ghost">${I.heart}</button></div>
<div class="rowlist list-lite" style="padding:0 20px">${D.tracks.map((t,i)=>`<button class="trk" data-play="${t.t}"${i===2?' data-playing':''}><div class="dur" style="width:22px;text-align:center">${i+1}</div><div class="info" style="margin-left:12px"><div class="tt">${t.t}</div><div class="ts">${t.a}</div></div><div class="dur">${t.d}</div></button>`).join('')}</div>
<div style="height:20px"></div></div>`};

S.artist=()=>{const a=D.artists[0];return `<div class="screen">${top('Library','library')}
<div class="hero">${art(2,'art','person')}<div><h1>${a.n}</h1><div class="meta">${a.al} albums · ${a.tr} tracks · 3.2 h</div></div></div>
<div class="actions"><button class="btn btn--pri" data-play="${D.tracks[0].t}">${I.play}Play</button><button class="btn" data-nav="stations">${I.radio}Station</button></div>
<div class="sec">${secHead('Albums')}<div class="grid">${D.albums.slice(3,5).map((al,i)=>`<button class="alb" data-nav="album" style="background:none;border:0;padding:0;text-align:left;color:inherit">${art(i+4,'art')}<div class="t">${al.t}</div><div class="s">${al.y}</div></button>`).join('')}</div></div>
<div class="sec">${secHead('Top tracks')}<div class="card" style="padding:2px 12px">${D.tracks.slice(0,4).map((t,i)=>trkRow(t,i)).join('')}</div></div>
<div style="height:14px"></div></div>`};

S.search=()=>`<div class="screen">${head('Search')}
<div class="searchfield">${I.search}<input placeholder="Tracks, albums, artists, folders"></div>
<div class="chiprow">${['All','Tracks','Albums','Artists','Lyrics'].map((c,i)=>`<span class="chip"${i===0?' data-on':''}>${c}</span>`).join('')}</div>
<div class="sec">${secHead('Recent searches')}<div class="rowlist">${['anderson paak','flac 24-bit','tiny desk'].map(q=>`<button class="rowitem" style="padding-left:0;padding-right:0">${I.history.replace('class="icon"','class="icon lead"')}<div class="rt">${q}</div>${I.chev.replace('class="icon"','class="icon chev"')}</button>`).join('')}</div></div>
<div class="sec">${secHead('Top result')}<div class="card" style="padding:2px 12px">${D.tracks.slice(2,5).map((t,i)=>trkRow(t,i+2)).join('')}</div></div></div>`;

S.crate=()=>`<div class="screen">${head('Crate','34 unsorted · 12 flagged · 8 duplicates')}
<div class="chiprow">${['Unsorted','Flagged','Duplicates','No tags','Low bitrate'].map((c,i)=>`<span class="chip"${i===0?' data-on':''}>${c}</span>`).join('')}</div>
<div class="sec"><div class="card" style="padding:14px"><div class="eyebrow">Batch</div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn" style="height:38px;font-size:12px">Tag all</button><button class="btn" style="height:38px;font-size:12px">Move…</button></div></div></div>
<div class="rowlist list-lite" style="padding:0 20px">${D.tracks.slice(0,6).map((t,i)=>`<button class="trk" data-play="${t.t}">${cov(i+1)}<div class="info"><div class="tt">${t.t}</div><div class="ts">${t.a} · no album tag</div></div>${'<span class="ico18">'+I.plus+'</span>'}</button>`).join('')}</div>
<div style="height:16px"></div></div>`;

S.playlists=()=>`<div class="screen">${head('Playlists','4 lists · 165 tracks',`<button class="iconbtn" style="color:var(--t1)">${I.plus}</button>`)}
<div class="rowlist">${D.playlists.map((p,i)=>`<button class="rowitem" data-nav="playlist">${art(i+1,'cov','note')}<div style="flex:1"><div class="rt">${p.n}</div><div class="ts" style="font-size:11.5px;color:var(--t3);margin-top:2px">${p.c} tracks</div></div>${I.chev.replace('class="icon"','class="icon chev"')}</button>`).join('')}</div></div>`;

S.playlist=()=>`<div class="screen">${top('Playlists','playlists')}
<div class="hero">${art(1,'art','note')}<div><h1>Late shift</h1><div class="meta">42 tracks · 2 h 47 min</div></div></div>
<div class="actions"><button class="btn btn--pri" data-play="${D.tracks[4].t}">${I.play}Play</button><button class="btn">${I.shuffle}Shuffle</button></div>
<div class="rowlist list-lite" style="padding:0 20px">${D.tracks.slice(0,6).map((t,i)=>trkRow(t,i)).join('')}</div>
<div style="height:16px"></div></div>`;

const stCard=(s,i)=>`<div class="stcard"${s.live?' data-live':''}>
<div class="stcard__tile" style="${tone(i+3)}">${I.sparkle}</div>
<div class="stcard__body"><div class="stcard__top"><div class="stcard__n">${s.n}</div>${s.live?'<span class="livetag"><i></i>live</span>':''}</div>
<div class="stcard__tags">${s.k} · ${s.tags}</div>
<div class="stcard__meta">${s.p} played · last ${s.last}</div></div>
<div class="stcard__acts"><button class="iconbtn sm" data-play="${s.n}">${I.play}</button><button class="iconbtn sm mute" data-del>${I.trash}</button></div></div>`;

S.stations=()=>{const live=D.smart[0];return `<div class="screen">${head('Stations','smart radio · seeds + embeddings','<span class="pill" style="align-self:center;white-space:nowrap">12 seeded</span>')}
<div class="sec"><div class="card livecard">
<div class="eyebrow live"><i></i>Live · streaming now</div>
<div class="sec-title" style="margin-top:8px">${live.n}</div>
<div class="livecard__sub">${live.d}</div>
<svg class="scatter" viewBox="0 0 300 78" preserveAspectRatio="none" aria-hidden="true">${[[54,46],[112,22],[168,58],[214,34],[262,50]].map((p,i)=>`<circle cx="${p[0]}" cy="${p[1]}" r="${i===1?4:3}" class="dot${i===1?' dot--on':''}"></circle>`).join('')}</svg>
<div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn--pri" style="height:38px;font-size:12px" data-play="${live.n}">${I.play}Resume station</button><button class="btn" style="height:38px;font-size:12px;flex:0 0 44px;padding:0" data-newseed title="New from current track">${I.radio}</button></div></div></div>
<div class="sec">${secHead('All stations')}
<button class="newmood" data-mood>${I.plus}<span>Nova mood station</span></button>
<div class="stlist">${D.smart.map(stCard).join('')}</div></div>
<div style="height:12px"></div></div>`;};

S.moodSheet=()=>`<div class="eyebrow">Nova mood station</div>
<div class="moodgrp"><div class="moodgrp__l">Mood</div><div class="chipwrap" data-multi>${D.moods.map(m=>`<button class="chip">${m}</button>`).join('')}</div></div>
<div class="moodgrp"><div class="moodgrp__l">Activity</div><div class="chipwrap" data-multi>${D.activities.map(m=>`<button class="chip">${m}</button>`).join('')}</div></div>
<div class="moodgrp"><div class="moodgrp__l">Seed track</div><div class="field"><select id="moodseed">${['Nenhuma (só mood)',...D.tracks.slice(0,5).map(t=>t.t)].map(o=>`<option>${o}</option>`).join('')}</select>${I.down}</div></div>
<div class="moodgrp"><div class="moodgrp__l">Nome</div><input class="field field--in" id="moodname" placeholder="Nome da station"></div>
<button class="btn btn--pri" id="moodgo" style="width:100%;margin-top:16px">Criar mood station</button>`;

S.history=()=>`<div class="screen">${head('History','1,204 plays · last 30 days')}
<div class="chiprow">${['Today','This week','This month','All'].map((c,i)=>`<span class="chip"${i===1?' data-on':''}>${c}</span>`).join('')}</div>
<div class="rowlist list-lite" style="padding:0 20px">${D.tracks.map((t,i)=>trkRow(t,i,t.ago+' ago')).join('')}</div>
<div style="height:16px"></div></div>`;

S.queue=()=>`<div class="screen">${head('Queue','1 playing · 7 next',`<button class="iconbtn" style="color:var(--t3)">${I.shuffle}</button>`)}
<div class="sec"><div class="eyebrow" style="margin-bottom:10px">Now playing</div><div class="card" style="padding:2px 12px;border-color:var(--accent-c)">${trkRow(D.tracks[0],0)}</div></div>
<div class="sec">${secHead('Next up')}<div class="rowlist list-lite">${D.tracks.slice(1,7).map((t,i)=>`<button class="trk" data-play="${t.t}">${'<span class="ico16">'+I.drag+'</span>'}${cov(i+1)}<div class="info"><div class="tt">${t.t}</div><div class="ts">${t.a}</div></div><div class="dur">${t.d}</div></button>`).join('')}</div></div>
<div style="height:14px"></div></div>`;

S.settings=()=>`<div class="screen">${head('Settings','Library, audio, appearance — v0.1.0')}
<div class="setpanel"><div class="setpanel__head"><div class="setpanel__title">Appearance</div><span class="setpanel__sub">really dark is the default mobile palette</span></div>
<div class="setrow"><div><div class="setrow__label">Theme</div><div class="setrow__hint">Auto follows your system preference. Light is the desktop Extractor Lab palette.</div></div><div class="seg" data-seg><button aria-pressed="false">Light</button><button aria-pressed="true">Dark</button><button aria-pressed="false">Auto</button></div></div>
<div class="setrow"><div><div class="setrow__label">Custom theme YAML</div><div class="setrow__hint">Themes em ~/rustify/themes/. Independente do mode acima.</div></div><button class="selbtn">Really Dark ▾</button></div>
<div class="setrow setrow--inline"><div><div class="setrow__label">Background render + shape</div><div class="setrow__hint">5 renderers × 23 shapes sobre o mesmo campo escalar.</div></div><div style="display:flex;gap:8px"><button class="selbtn" id="rendersel" style="width:auto" onclick="window.useRenderer.next()">${window.useRenderer.name()}</button><button class="selbtn" id="shapesel" style="width:auto" onclick="window.useShape.next()">${window.useShape.name()}</button></div></div>
<div class="setrow"><div><div class="setrow__label">Beat sync</div><div class="setrow__hint">Speed empurra a derivada do relógio com a energia do kick; Pulse trava fase por PLL e pulsa a amplitude.</div></div><div class="seg" data-seg data-beat><button aria-pressed="false">Off</button><button aria-pressed="false">Subtle</button><button aria-pressed="true">Default</button><button aria-pressed="false">Pulse</button></div></div>
<div class="setrow setrow--inline"><div><div class="setrow__label">Full-screen player</div><div class="setrow__hint">Esconde o dock enquanto o Now Playing está aberto.</div></div><button class="tog" aria-pressed="false" data-tog></button></div>
</div>

<div class="setpanel"><div class="setpanel__head"><div class="setpanel__title">Playback</div><span class="setpanel__sub">default output · 44.1 kHz</span></div>
<div class="setrow setrow--inline"><div><div class="setrow__label">Resume on launch</div><div class="setrow__hint">Re-abre a última faixa na última posição.</div></div><button class="tog" aria-pressed="true" data-tog></button></div>
<div class="setrow"><div><div class="setrow__label">Volume</div><div class="setrow__hint">Sincroniza com o player (engine-level).</div></div><div style="display:flex;align-items:center;gap:12px"><input class="range" type="range" min="0" max="100" value="72"><span class="rv" style="font-family:var(--mono);font-size:11px;color:var(--t3);min-width:34px">72%</span></div></div>
<div class="setrow setrow--inline"><div><div class="setrow__label">Normalizar volume entre faixas</div><div class="setrow__hint">EBU R128 alvo −14 LUFS, entre EQ e Limiter.</div></div><button class="tog" aria-pressed="true" data-tog></button></div>
</div>

<div class="setpanel"><div class="setpanel__head"><div class="setpanel__title">Library</div><span class="setpanel__sub">1,746 tracks · 12 albums</span></div>
<div class="setrow"><div><div class="setrow__label">Music folder</div><div class="setrow__hint mono">/storage/emulated/0/Music</div></div></div>
<div class="setrow"><div><div class="setrow__label">Re-scan library</div><div class="setrow__hint">Re-indexa metadados e gera embeddings faltantes.</div></div><button class="selbtn selbtn--accent">Re-scan</button></div>
<div class="setrow"><div><div class="setrow__label">Embeddings</div><div class="setrow__hint">1,420 of 1,746 tracks têm AI embeddings. Drives the station recommender.</div></div></div>
<div class="setrow setrow--inline"><div><div class="setrow__label">qdrant process</div><div class="setrow__hint mono">localhost:6333 · vec-dim 1024</div></div><span class="pill pill--ok">ok</span></div>
<div class="statgrid">${[['TRACKS','1,746','indexed'],['ALBUMS','12','distinct'],['ARTISTS','38','distinct'],['GENRES','47','populated']].map(t=>`<div class="stile"><span class="stile__l">${t[0]}</span><span class="stile__v">${t[1]}</span><span class="stile__s">${t[2]}</span></div>`).join('')}</div>
</div>

<div class="setpanel"><div class="setpanel__head"><div class="setpanel__title">About</div><span class="setpanel__sub">rustify-player · Pedro Giudice</span></div>
<div class="setrow"><div><div class="setrow__label">Updates</div><div class="setrow__hint">Você está na última — v0.1.0</div></div><button class="selbtn">Check for updates</button></div>
<div class="aboutgrid">${[['Version','0.1.0'],['Tauri','2.x'],['Backend','Rust · GStreamer'],['Identifier','dev.cmr.rustifyplayer'],['Branch','fix-playback-race-condition'],['License','GPL-3.0']].map(a=>`<div class="aitem"><span class="aitem__l">${a[0]}</span><span class="aitem__v">${a[1]}</span></div>`).join('')}</div>
</div>

<div class="setrow" style="border:0"><button class="rowitem" data-nav="signal" style="padding:0">${I.sliders.replace('class="icon"','class="icon lead"')}<div class="rt">Signal · DSP chain</div><div class="rv">Bypassed</div>${I.chev.replace('class="icon"','class="icon chev"')}</button></div>
<div style="height:10px"></div></div>`;

S.signal=()=>`<div class="screen">${top('Settings','settings')}${head('Signal','DSP chain · bypassed')}
<div class="sec"><div class="card" style="padding:16px"><div style="display:flex;align-items:center;justify-content:space-between"><div class="eyebrow">Chain</div><span class="chip" style="padding:4px 10px">Bypass</span></div><div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">${['Equalizer','Crossfeed','Limiter'].map((n,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid var(--div-subtle);border-radius:var(--r-md);background:var(--s-high)"><span style="width:6px;height:6px;border-radius:50%;background:${i===0?'var(--ok)':'var(--t4)'}"></span><span style="flex:1;font-size:13px">${n}</span><span class="rv" style="font-family:var(--mono);font-size:11px;color:var(--t3)">${i===0?'active':'off'}</span></div>`).join('')}</div></div></div>
<div class="sec">${secHead('Equalizer')}<div class="card" style="padding:18px 16px"><div style="display:flex;align-items:flex-end;justify-content:space-between;height:120px">${[3,5,4,6,5,3,4,6,5,4].map((v,i)=>`<div style="display:flex;flex-direction:column;align-items:center;gap:8px;flex:1"><div style="width:3px;height:88px;background:var(--div-subtle);border-radius:2px;position:relative"><i style="position:absolute;left:-3px;width:9px;height:9px;border-radius:50%;background:var(--accent);bottom:${v*12}px"></i></div><span style="font-family:var(--mono);font-size:8.5px;color:var(--t4)">${[32,64,125,250,500,'1k','2k','4k','8k','16k'][i]}</span></div>`).join('')}</div></div></div>
<div class="sec">${secHead('Output')}<div class="rowlist">${[['Sample rate','44.1 kHz'],['Bit depth','16-bit'],['Buffer','256']].map(r=>`<div class="rowitem" style="padding-left:0;padding-right:0"><div class="rt">${r[0]}</div><div class="rv">${r[1]}</div></div>`).join('')}</div></div>
<div style="height:14px"></div></div>`;
window.SCREENS=S;
})();
