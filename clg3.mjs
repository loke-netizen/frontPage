// Emergency Skill Share – Pro Single‑File App (Node + Socket.IO + Map)
// ----------------------------------------------------------------------------
// What this is:
//   A production‑style, single‑file Node app that demonstrates a real‑time
//   "Uber‑for‑help" emergency skill exchange with:
//     • Fastify (HTTP server) + Socket.IO (real‑time)
//     • Secure headers, compression, and rate‑limiting
//     • Proximity‑based matching (Haversine)
//     • Multi‑helper dispatch (first‑accept wins)
//     • Minimal, sleek client with a live map (Leaflet via CDN)
//     • Zero external DB; uses in‑memory stores for demo (swap for Redis/DB in prod)
//
// How to run:
//   1) Node 18+
//   2) npm i fastify @fastify/helmet @fastify/rate-limit @fastify/compress socket.io
//   3) node app.mjs (or: node app.js depending on filename)
//   4) Open http://localhost:4000
//
// Notes:
//   • This is intentionally single‑file to make it easy to copy/run.
//   • For production: move stores to Redis/Postgres, add auth/JWT/CSRF, logging,
//     and durable queues. The matching core here is architected to drop into that.

import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import compress from '@fastify/compress'
import { Server as IOServer } from 'socket.io'

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000

// --------------------------------- Utilities ---------------------------------
const now = () => Date.now()

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function uid(prefix = '') {
  return (
    prefix + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)
  )
}

// ------------------------------ In‑Memory Stores ------------------------------
/**
 * connections: Map<socketId, {
 *   id: string,
 *   role: 'helper' | 'seeker',
 *   name: string,
 *   skills: Set<string>,
 *   location?: { lat:number, lng:number, updatedAt:number },
 *   available: boolean,
 *   rating: number,
 * }>
 */
const connections = new Map()

/**
 * emergencies: Map<emergencyId, {
 *   id: string,
 *   seekerSocketId: string,
 *   requiredSkill: string,
 *   location: { lat:number, lng:number },
 *   note?: string,
 *   createdAt: number,
 *   status: 'pending' | 'dispatched' | 'accepted' | 'cancelled' | 'resolved',
 *   assignedHelper?: { socketId: string, name: string },
 *   responders: Set<string>, // helper socketIds pinged
 * }>
 */
const emergencies = new Map()

// For simple anti‑spam on posting emergencies
const lastEmergencyAtByIP = new Map()
const POST_COOLDOWN_MS = 5000

// Matching config
const SEARCH_RADIUS_KM = 5 // configurable per severity
const MAX_PARALLEL_DISPATCH = 3 // ping top N helpers; first to accept wins

// ------------------------------ Fastify Setup --------------------------------
const fastify = Fastify({ logger: false })
await fastify.register(helmet)
await fastify.register(compress)
await fastify.register(rateLimit, { max: 200, timeWindow: '1 minute' })

fastify.get('/', async (req, reply) => {
  return reply.header('content-type', 'text/html').send(indexHTML)
})

// Health
fastify.get('/health', async () => ({ ok: true, t: Date.now() }))

// Create HTTP server & Socket.IO
const io = new IOServer(fastify.server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
})

// --------------------------------- Matching ----------------------------------
function rankHelpers({ requiredSkill, lat, lng }) {
  const candidates = []
  for (const [sid, c] of connections) {
    if (c.role !== 'helper') continue
    if (!c.available) continue
    if (!c.location) continue
    if (!c.skills.has(requiredSkill)) continue
    const d = haversineKm(lat, lng, c.location.lat, c.location.lng)
    if (d <= SEARCH_RADIUS_KM) {
      candidates.push({ sid, c, d })
    }
  }
  // sort by distance then by rating desc then by last location update recency
  candidates.sort((a, b) => {
    if (a.d !== b.d) return a.d - b.d
    if (a.c.rating !== b.c.rating) return b.c.rating - a.c.rating
    const au = a.c.location?.updatedAt ?? 0
    const bu = b.c.location?.updatedAt ?? 0
    return bu - au
  })
  return candidates.slice(0, 25) // cap
}

function dispatchEmergency(em) {
  const ranked = rankHelpers({
    requiredSkill: em.requiredSkill,
    lat: em.location.lat,
    lng: em.location.lng,
  })

  const targets = ranked.slice(0, Math.max(1, MAX_PARALLEL_DISPATCH))
  for (const { sid, c, d } of targets) {
    em.responders.add(sid)
    io.to(sid).emit('dispatch', {
      emergencyId: em.id,
      requiredSkill: em.requiredSkill,
      seekerApprox: { lat: em.location.lat, lng: em.location.lng },
      distanceKm: Number(d.toFixed(2)),
      note: em.note || '',
      createdAt: em.createdAt,
    })
  }

  if (targets.length > 0) {
    em.status = 'dispatched'
  }

  // Notify seeker with how many helpers were pinged
  io.to(em.seekerSocketId).emit('dispatch:summary', {
    emergencyId: em.id,
    pinged: targets.length,
  })
}

// ------------------------------- Socket Logic --------------------------------
io.on('connection', (socket) => {
  // Minimal handshake
  socket.on('hello', (payload, ack) => {
    const { role, name, skills = [], rating = 4.5 } = payload || {}
    const entry = {
      id: socket.id,
      role: role === 'helper' ? 'helper' : 'seeker',
      name: typeof name === 'string' && name.trim() ? name.trim() : 'Guest',
      skills: new Set(Array.isArray(skills) ? skills.map((s) => s.toLowerCase()) : []),
      location: undefined,
      available: true,
      rating: Number(rating) || 4.5,
    }
    connections.set(socket.id, entry)
    ack?.({ ok: true, id: socket.id })
  })

  socket.on('status:availability', (data) => {
    const c = connections.get(socket.id)
    if (!c) return
    c.available = !!data?.available
  })

  socket.on('location:update', (loc) => {
    const c = connections.get(socket.id)
    if (!c) return
    const { lat, lng } = loc || {}
    if (typeof lat === 'number' && typeof lng === 'number') {
      c.location = { lat, lng, updatedAt: now() }
    }
  })

  // Seeker posts an emergency
  socket.on('emergency:post', (payload, ack) => {
    const c = connections.get(socket.id)
    if (!c) return ack?.({ ok: false, error: 'not_connected' })
    if (c.role !== 'seeker') return ack?.({ ok: false, error: 'not_seeker' })

    // Cooldown per IP
    const ip = socket.handshake.address || 'unknown'
    const lastAt = lastEmergencyAtByIP.get(ip) || 0
    if (now() - lastAt < POST_COOLDOWN_MS) {
      return ack?.({ ok: false, error: 'too_many_requests' })
    }
    lastEmergencyAtByIP.set(ip, now())

    const requiredSkill = String(payload?.requiredSkill || '').toLowerCase().trim()
    const note = String(payload?.note || '')
    const location = payload?.location || {}
    if (!requiredSkill) return ack?.({ ok: false, error: 'missing_skill' })
    if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      return ack?.({ ok: false, error: 'missing_location' })
    }

    const em = {
      id: uid('em_'),
      seekerSocketId: socket.id,
      requiredSkill,
      location: { lat: location.lat, lng: location.lng },
      note,
      createdAt: now(),
      status: 'pending',
      assignedHelper: undefined,
      responders: new Set(),
    }
    emergencies.set(em.id, em)

    dispatchEmergency(em)
    ack?.({ ok: true, emergencyId: em.id })
  })

  // Helper accepts
  socket.on('emergency:accept', ({ emergencyId }, ack) => {
    const c = connections.get(socket.id)
    if (!c || c.role !== 'helper') return ack?.({ ok: false, error: 'not_helper' })
    const em = emergencies.get(emergencyId)
    if (!em) return ack?.({ ok: false, error: 'not_found' })
    if (em.status === 'cancelled' || em.status === 'resolved') {
      return ack?.({ ok: false, error: 'closed' })
    }
    if (em.assignedHelper) {
      return ack?.({ ok: false, error: 'taken' })
    }

    // lock
    em.assignedHelper = { socketId: socket.id, name: c.name }
    em.status = 'accepted'
    c.available = false

    // notify seeker
    io.to(em.seekerSocketId).emit('emergency:accepted', {
      emergencyId: em.id,
      helper: { id: socket.id, name: c.name },
    })

    // notify other responders
    for (const sid of em.responders) {
      if (sid !== socket.id) io.to(sid).emit('emergency:taken', { emergencyId: em.id })
    }

    ack?.({ ok: true })
  })

  // Seeker cancels
  socket.on('emergency:cancel', ({ emergencyId }, ack) => {
    const c = connections.get(socket.id)
    const em = emergencies.get(emergencyId)
    if (!c || !em) return ack?.({ ok: false })
    if (em.seekerSocketId !== socket.id) return ack?.({ ok: false, error: 'not_owner' })
    em.status = 'cancelled'
    io.to(emergencyId)
    for (const sid of em.responders) io.to(sid).emit('emergency:cancelled', { emergencyId })
    if (em.assignedHelper) io.to(em.assignedHelper.socketId).emit('emergency:cancelled', { emergencyId })
    ack?.({ ok: true })
  })

  // Mark resolved (helper)
  socket.on('emergency:resolved', ({ emergencyId }, ack) => {
    const c = connections.get(socket.id)
    const em = emergencies.get(emergencyId)
    if (!c || !em) return ack?.({ ok: false })
    if (!em.assignedHelper || em.assignedHelper.socketId !== socket.id) {
      return ack?.({ ok: false, error: 'not_assigned_helper' })
    }
    em.status = 'resolved'
    c.available = true
    io.to(em.seekerSocketId).emit('emergency:resolved', { emergencyId })
    ack?.({ ok: true })
  })

  socket.on('disconnect', () => {
    // if a helper disconnects while assigned, free emergency state (soft)
    const c = connections.get(socket.id)
    if (c) {
      // Reopen any accepted emergency (basic handling for demo)
      for (const em of emergencies.values()) {
        if (em.assignedHelper?.socketId === socket.id && em.status === 'accepted') {
          em.assignedHelper = undefined
          em.status = 'pending'
          dispatchEmergency(em)
        }
      }
      connections.delete(socket.id)
    }
  })
})

// ---------------------------------- Start ------------------------------------
fastify.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`\n⚡ Emergency Skill Share running at http://localhost:${PORT}`)
})

// --------------------------------- Client UI ---------------------------------
const indexHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Emergency Skill Share</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
  <style>
    :root{ --bg:#0b1020; --panel:#121934; --muted:#94a3b8; --accent:#4f46e5; --good:#16a34a; --bad:#dc2626; }
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:linear-gradient(180deg,#0b1020,#0a0f22);color:#e5e7eb}
    .wrap{display:grid;grid-template-columns:360px 1fr;height:100vh}
    aside{background:rgba(18,25,52,.9);backdrop-filter:blur(8px);padding:16px 16px 24px;border-right:1px solid rgba(255,255,255,.06)}
    main{position:relative}
    #map{position:absolute;inset:0}
    h1{margin:0 0 8px;font-size:20px;font-weight:700;letter-spacing:.2px}
    .sub{color:var(--muted);font-size:12px;margin-bottom:16px}
    .card{background:#0f1530;border:1px solid rgba(255,255,255,.05);border-radius:16px;padding:12px;margin-bottom:12px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    .row{display:flex;gap:8px}
    input,select,textarea{width:100%;padding:10px 12px;background:#0b1128;border:1px solid rgba(255,255,255,.08);border-radius:12px;color:#e5e7eb}
    textarea{min-height:68px;resize:vertical}
    button{all:unset;display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;background:var(--accent);border-radius:12px;font-weight:600;cursor:pointer}
    button[disabled]{opacity:.6;cursor:not-allowed}
    .seg{display:flex;background:#0b1128;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden}
    .seg button{flex:1;background:transparent}
    .seg button.active{background:var(--accent)}
    .log{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;font-size:12px;background:#0a0f22;border:1px dashed rgba(255,255,255,.08);border-radius:12px;padding:10px;height:130px;overflow:auto;white-space:pre-wrap}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:#0b1128;border:1px solid rgba(255,255,255,.08);border-radius:999px;font-size:12px;color:var(--muted)}
    .ok{color:#22c55e}
    .warn{color:#f59e0b}
    .err{color:#ef4444}
  </style>
</head>
<body>
<div class="wrap">
  <aside>
    <h1>Emergency Skill Share</h1>
    <div class="sub">Post emergencies, auto‑match nearby helpers. Real‑time & map‑first.</div>

    <div class="card">
      <div class="seg" id="roleSeg">
        <button data-role="seeker" class="active">I need help</button>
        <button data-role="helper">I can help</button>
      </div>
      <div style="height:8px"></div>
      <div class="row">
        <input id="name" placeholder="Your name" />
      </div>
      <div class="row" id="helperSkills" style="display:none">
        <input id="skills" placeholder="Helper skills (comma: bike,tyre,first-aid)" />
      </div>
      <div class="row">
        <button id="connectBtn">Connect</button>
        <span class="badge" id="statusBadge">offline</span>
      </div>
    </div>

    <div class="card" id="seekerForm">
      <select id="skillSelect">
        <option value="">— Required skill —</option>
        <option value="bike">Bike repair</option>
        <option value="mechanic">Mechanic</option>
        <option value="first-aid">First Aid</option>
        <option value="electric">Electrician</option>
      </select>
      <div style="height:8px"></div>
      <textarea id="note" placeholder="What happened? (short note)"></textarea>
      <div class="row">
        <button id="postBtn" disabled>Post emergency</button>
      </div>
    </div>

    <div class="card" id="helperPanel" style="display:none">
      <div class="row">
        <button id="availBtn">Go offline</button>
        <span class="badge">Waiting for dispatch…</span>
      </div>
      <div id="incoming" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="log" id="log"></div>
    </div>
  </aside>
  <main>
    <div id="map"></div>
  </main>
</div>

<script src="https://cdn.socket.io/4.7.4/socket.io.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
  const $ = (s) => document.querySelector(s)
  const log = (m, cls='') => { const el=$('#log'); const line=document.createElement('div'); line.textContent = m; if(cls) line.className = cls; el.prepend(line); }
  const statusBadge = $('#statusBadge')
  const roleSeg = document.querySelectorAll('#roleSeg button')
  let role = 'seeker'
  roleSeg.forEach(b=>b.onclick=()=>{ roleSeg.forEach(x=>x.classList.remove('active')); b.classList.add('active'); role=b.dataset.role; refreshRoleUI(); })

  function refreshRoleUI(){
    if(role==='seeker'){ $('#seekerForm').style.display='block'; $('#helperPanel').style.display='none'; $('#helperSkills').style.display='none' }
    else { $('#seekerForm').style.display='none'; $('#helperPanel').style.display='block'; $('#helperSkills').style.display='block' }
  }

  // Map
  const map = L.map('map', { zoomControl: true })
  map.setView([13.0827, 80.2707], 13) // default: Chennai
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
  const meMarker = L.marker([13.0827,80.2707]).addTo(map)
  let seekerMarker = null

  // Geolocation
  function updatePosition(){
    if(!navigator.geolocation){ log('Geolocation not supported','warn'); return }
    navigator.geolocation.getCurrentPosition((pos)=>{
      const { latitude, longitude } = pos.coords
      meMarker.setLatLng([latitude, longitude])
      map.setView([latitude, longitude], 15)
      if(window.socket?.connected){ socket.emit('location:update', { lat: latitude, lng: longitude }) }
    }, (err)=>{ log('Geo error: '+err.message,'err')})
  }
  updatePosition(); setInterval(updatePosition, 8000)

  // Socket
  let socket = null
  let connected = false
  let myId = null

  $('#connectBtn').onclick = () => {
    if(connected){ socket.disconnect(); return }
    socket = io('/', { transports: ['websocket'], upgrade: false })
    socket.on('connect', () => {
      connected = true; myId = socket.id; statusBadge.textContent='online'; $('#connectBtn').textContent='Disconnect'; log('Connected ✓','ok')
      const name = $('#name').value.trim() || 'Guest'
      const skills = $('#skills').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
      socket.emit('hello', { role, name, skills })
      // initial location
      navigator.geolocation.getCurrentPosition((pos)=>{
        socket.emit('location:update', { lat: pos.coords.latitude, lng: pos.coords.longitude })
      })
    })
    socket.on('disconnect', () => { connected=false; statusBadge.textContent='offline'; $('#connectBtn').textContent='Connect'; log('Disconnected','warn') })

    // Dispatches to helpers
    socket.on('dispatch', (d) => {
      log('Incoming dispatch: '+d.requiredSkill+' ('+d.distanceKm+' km)','warn')
      const inEl = document.createElement('div')
      inEl.className='card'
      inEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px">Emergency needs: ${'${d.requiredSkill}'}</div>
        <div class="sub">Approx ${'${d.distanceKm}'} km away · ${'${new Date(d.createdAt).toLocaleTimeString()}'} </div>
        <div class="row" style="margin-top:8px">
          <button id="acc_${'${d.emergencyId}'}">Accept</button>
        </div>`
      $('#incoming').prepend(inEl)
      document.querySelector('#acc_'+d.emergencyId).onclick = () => {
        socket.emit('emergency:accept', { emergencyId: d.emergencyId }, (res)=>{
          if(res?.ok){ log('Accepted. Connecting to seeker…','ok') }
          else { log('Accept failed: '+(res?.error||'error'),'err') }
        })
      }
      // show seeker on map
      if(seekerMarker) seekerMarker.remove()
      seekerMarker = L.circleMarker([d.seekerApprox.lat, d.seekerApprox.lng], { radius: 8 }).addTo(map)
    })

    socket.on('emergency:taken', ({ emergencyId }) => {
      log('Another helper took emergency '+emergencyId,'warn')
    })

    socket.on('emergency:accepted', ({ emergencyId, helper }) => {
      log('Helper '+helper.name+' accepted your emergency ('+emergencyId+')','ok')
      alert('Helper '+helper.name+' is on the way!')
    })

    socket.on('dispatch:summary', ({ emergencyId, pinged }) => {
      log('Dispatched to '+pinged+' nearby helpers for '+emergencyId)
    })

    socket.on('emergency:cancelled', ({ emergencyId }) => {
      log('Emergency cancelled '+emergencyId,'warn')
    })

    socket.on('emergency:resolved', ({ emergencyId }) => {
      log('Emergency resolved '+emergencyId,'ok')
      if(seekerMarker) { seekerMarker.remove(); seekerMarker = null }
    })
  }

  // Seeker: post emergency
  $('#postBtn').onclick = () => {
    const requiredSkill = $('#skillSelect').value
    if(!requiredSkill) return alert('Select a required skill')
    navigator.geolocation.getCurrentPosition((pos)=>{
      const payload = {
        requiredSkill,
        note: $('#note').value.trim(),
        location: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      }
      socket.emit('emergency:post', payload, (res)=>{
        if(res?.ok){ log('Posted emergency '+res.emergencyId, 'ok') }
        else { log('Post failed: '+(res?.error||'error'),'err') }
      })
    }, ()=> alert('Location permission required'))
  }

  // Helper availability toggle
  $('#availBtn').onclick = () => {
    const goingOffline = $('#availBtn').textContent.includes('offline')
    socket.emit('status:availability', { available: !goingOffline })
    $('#availBtn').textContent = goingOffline ? 'Go online' : 'Go offline'
  }

  // Enable post only when online as seeker
  const observer = new MutationObserver(()=>{
    const enabled = (role==='seeker' && connected)
    $('#postBtn').disabled = !enabled
  })
  observer.observe(document.body, { attributes:true, childList:true, subtree:true })
</script>
</body>
</html>`
