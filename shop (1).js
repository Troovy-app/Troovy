/* Troovy – fonction serveur unique (Vercel) : /api/shop?action=...
   Aucune bibliothèque à installer. Les clés secrètes ne sont JAMAIS écrites ici :
   elles se règlent dans Vercel > Settings > Environment Variables.            */
const crypto = require("crypto");

/* ============ Réglages modifiables (c'est ici que tu changes tes tarifs) ============ */
const SETTINGS = {
  /* Livraison offerte à partir de ce montant d'articles (en centimes : 6000 = 60 €) */
  FREE_SHIPPING_FROM_CENTS: 6000,
  /* Tarifs selon le poids du colis. EXEMPLES : remplace-les par les tarifs de ton transporteur. */
  SHIPPING_TIERS: [
    { max_g: 500,  cents: 450 },   /* jusqu'à 500 g   : 4,50 € */
    { max_g: 1000, cents: 590 },   /* jusqu'à 1 kg    : 5,90 € */
    { max_g: 2000, cents: 790 },   /* jusqu'à 2 kg    : 7,90 € */
    { max_g: 5000, cents: 1090 }   /* jusqu'à 5 kg    : 10,90 € */
  ],
  PACKAGING_G: 100,                /* poids de l'emballage ajouté à chaque colis */
  COUNTRIES: ["FR"],               /* pays de livraison acceptés */
  /* Poids moyen d'un article par catégorie (en grammes), utilisé si tu n'indiques pas le poids exact */
  CATEGORY_WEIGHT_G: { "Hauts":200, "Pulls et gilets":400, "Robes et jupes":350, "Pantalons et jeans":500,
    "Vestes et manteaux":900, "Ensembles et pyjamas":400, "Chaussures":800, "Sacs":600, "Accessoires":150, "Autre":300 },
  /* Les vêtements bébé et enfant sont plus légers */
  SECTION_FACTOR: { bebe: 0.6, enfant: 0.8 }
};
/* =================================================================================== */

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://bteonwvpvlycpghcgceq.supabase.co").replace(/\/$/, "");
const env = k => process.env[k] || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function weightOf(p){
  if(p.weight_g > 0) return Math.round(p.weight_g);
  const base = SETTINGS.CATEGORY_WEIGHT_G[p.category] ?? 300;
  const f = SETTINGS.SECTION_FACTOR[p.section] ?? 1;
  return Math.round(base * f);
}
function shippingFor(items){
  const subtotal = items.reduce((s,p)=>s+p.price_cents,0);
  const weight = items.reduce((s,p)=>s+weightOf(p),0) + SETTINGS.PACKAGING_G;
  if(subtotal >= SETTINGS.FREE_SHIPPING_FROM_CENTS) return {subtotal, weight, cents:0, free:true};
  const tiers = SETTINGS.SHIPPING_TIERS;
  const t = tiers.find(x=>weight<=x.max_g) || tiers[tiers.length-1];
  return {subtotal, weight, cents:t.cents, free:false};
}

/* ---------- Appels Supabase (clé secrète côté serveur) ---------- */
async function sb(path, o={}){
  const key = env("SUPABASE_SERVICE_KEY");
  const headers = {apikey:key, "Content-Type":"application/json"};
  if(key.startsWith("eyJ")) headers.Authorization = "Bearer "+key;
  if(o.prefer) headers.Prefer = o.prefer;
  const r = await fetch(SUPABASE_URL+"/rest/v1/"+path, {method:o.method||"GET", headers, body:o.body?JSON.stringify(o.body):undefined});
  const txt = await r.text();
  if(!r.ok) throw new Error("Supabase "+r.status+" "+txt.slice(0,200));
  return txt ? JSON.parse(txt) : null;
}
const inList = ids => "in.("+ids.join(",")+")";

/* ---------- Appels Stripe ---------- */
function flat(obj, prefix, out=[]){
  for(const [k,v] of Object.entries(obj)){
    if(v===undefined || v===null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if(Array.isArray(v)) v.forEach((x,i)=> (x && typeof x==="object") ? flat(x,`${key}[${i}]`,out) : out.push([`${key}[${i}]`,String(x)]));
    else if(typeof v==="object") flat(v,key,out);
    else out.push([key,String(v)]);
  }
  return out;
}
async function stripe(method, path, params){
  const r = await fetch("https://api.stripe.com/v1"+path, {
    method, headers:{Authorization:"Bearer "+env("STRIPE_SECRET_KEY"), "Content-Type":"application/x-www-form-urlencoded"},
    body: params ? new URLSearchParams(flat(params)).toString() : undefined });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("Stripe "+r.status+" "+((j.error&&j.error.message)||""));
  return j;
}

/* ---------- Utilitaires ---------- */
function send(res, status, obj){ res.statusCode = status; res.setHeader("Content-Type","application/json; charset=utf-8"); res.setHeader("Cache-Control","no-store"); res.end(JSON.stringify(obj)); }
async function raw(req){ const c=[]; for await (const x of req) c.push(typeof x==="string"?Buffer.from(x):x); return Buffer.concat(c); }
const eur = c => (c/100).toFixed(2).replace(".",",")+" €";
function orderNumber(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s="TR-"; for(let i=0;i<6;i++) s+=a[crypto.randomInt(a.length)]; return s; }
async function release(ids){ if(ids.length) await sb(`products?id=${inList(ids)}&status=eq.reserved`,{method:"PATCH",body:{status:"available"}}); }
const siteUrl = req => env("SITE_URL") || ("https://"+(req.headers["x-forwarded-host"]||req.headers.host));

async function notify(order){
  const key = env("RESEND_API_KEY"), to = env("NOTIFY_EMAIL");
  if(!key || !to) return;
  const a = order.address || {};
  const lines = (order.items||[]).map(i=>`- ${i.title}${i.size?` (${i.size})`:""} : ${eur(i.price_cents)}`).join("\n");
  const text = `Nouvelle commande payée : ${order.number}\n\n${lines}\n\nArticles : ${eur(order.subtotal_cents)}\nFrais de port : ${eur(order.shipping_cents)}\nTotal payé : ${eur(order.total_cents)}\n\nCliente : ${order.name||""}\nE-mail : ${order.email||""}\nTéléphone : ${order.phone||""}\nAdresse : ${[a.line1,a.line2,a.postal_code,a.city,a.country].filter(Boolean).join(", ")}\n\nÀ préparer, puis à passer en « Expédiée » dans ton espace admin > Commandes.`;
  try{ await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({from:"Troovy <onboarding@resend.dev>",to:[to],subject:`Troovy : commande ${order.number} payée (${eur(order.total_cents)})`,text})}); }catch(e){}
}

/* ---------- Actions ---------- */
async function config(){
  return {enabled: !!(env("STRIPE_SECRET_KEY") && env("SUPABASE_SERVICE_KEY")), free_from_cents:SETTINGS.FREE_SHIPPING_FROM_CENTS,
    tiers:SETTINGS.SHIPPING_TIERS, packaging_g:SETTINGS.PACKAGING_G, category_weight_g:SETTINGS.CATEGORY_WEIGHT_G, section_factor:SETTINGS.SECTION_FACTOR, countries:SETTINGS.COUNTRIES};
}

async function checkout(req, res){
  if(!env("STRIPE_SECRET_KEY") || !env("SUPABASE_SERVICE_KEY")) return send(res,503,{error:"Le paiement en ligne n'est pas encore activé."});
  let body; try{ body = JSON.parse((await raw(req)).toString()||"{}"); }catch(e){ return send(res,400,{error:"Requête invalide."}); }
  const ids = [...new Set(Array.isArray(body.ids)?body.ids:[])];
  if(!ids.length || ids.length>30 || !ids.every(i=>UUID.test(i))) return send(res,400,{error:"Panier vide ou invalide."});
  const cols = "id,title,brand,size,price_cents,photos,status,category,section,weight_g";
  const found = await sb(`products?id=${inList(ids)}&select=${cols}`);
  const byId = new Map(found.map(p=>[p.id,p]));
  const gone = ids.filter(i=>!byId.has(i) || byId.get(i).status!=="available");
  if(gone.length) return send(res,409,{error:"Un ou plusieurs articles ne sont plus disponibles.", unavailable:gone});
  /* Réserve les pièces uniques (une seule cliente peut les réserver) */
  const got = await sb(`products?id=${inList(ids)}&status=eq.available`,{method:"PATCH",body:{status:"reserved"},prefer:"return=representation"});
  if(got.length!==ids.length){
    await release(got.map(p=>p.id));
    const ok = new Set(got.map(p=>p.id));
    return send(res,409,{error:"Un article vient d'être réservé par une autre personne.", unavailable:ids.filter(i=>!ok.has(i))});
  }
  const items = ids.map(i=>byId.get(i));
  const ship = shippingFor(items);
  const total = ship.subtotal + ship.cents;
  let order;
  try{
    for(let k=0;k<4 && !order;k++){
      try{
        const r = await sb("shop_orders",{method:"POST",prefer:"return=representation",body:{
          number:orderNumber(), status:"pending", subtotal_cents:ship.subtotal, shipping_cents:ship.cents, total_cents:total, weight_g:ship.weight,
          items: items.map(p=>({id:p.id,title:p.title,brand:p.brand||null,size:p.size||null,price_cents:p.price_cents,photo:(p.photos||[])[0]||null})) }});
        order = r[0];
      }catch(e){ if(!/duplicate|unique/i.test(e.message)) throw e; }
    }
    if(!order) throw new Error("Numéro de commande indisponible");
    const base = siteUrl(req);
    const session = await stripe("POST","/checkout/sessions",{
      mode:"payment", locale:"fr", client_reference_id:order.number,
      expires_at: Math.floor(Date.now()/1000)+31*60,
      success_url: `${base}/#/commande/merci?o=${order.id}`,
      cancel_url: `${base}/#/commande/annulee?o=${order.id}`,
      metadata:{order_id:order.id, number:order.number},
      payment_intent_data:{description:`Troovy ${order.number}`, metadata:{order_id:order.id, number:order.number}},
      shipping_address_collection:{allowed_countries:SETTINGS.COUNTRIES},
      phone_number_collection:{enabled:true},
      billing_address_collection:"auto",
      customer_email: (typeof body.email==="string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) ? body.email : undefined,
      custom_text:{submit:{message:"En payant, tu acceptes les conditions générales de vente de Troovy. Tu disposes de 14 jours pour te rétracter."}},
      line_items: items.map(p=>({quantity:1, price_data:{currency:"eur", unit_amount:p.price_cents,
        product_data:{name:p.title+(p.size?` – ${p.size}`:""), description:p.brand||undefined, images:(p.photos&&/^https:\/\//.test(p.photos[0]||""))?[p.photos[0]]:undefined}}})),
      shipping_options:[{shipping_rate_data:{type:"fixed_amount", display_name: ship.cents? "Frais de port" : "Livraison offerte", fixed_amount:{amount:ship.cents, currency:"eur"}}}]
    });
    await sb(`shop_orders?id=eq.${order.id}`,{method:"PATCH",body:{stripe_session:session.id}});
    return send(res,200,{url:session.url, order:order.id, number:order.number});
  }catch(e){
    await release(ids).catch(()=>{});
    if(order) await sb(`shop_orders?id=eq.${order.id}`,{method:"PATCH",body:{status:"cancelled",note:"Échec création du paiement"}}).catch(()=>{});
    console.error(e.message);
    return send(res,502,{error:"Impossible de lancer le paiement. Réessaie dans un instant."});
  }
}

function verifySignature(rawBody, header, secret){
  if(!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map(x=>x.split("=")));
  const t = parts.t; if(!t || !parts.v1) return false;
  if(Math.abs(Date.now()/1000 - Number(t)) > 600) return false;
  const exp = crypto.createHmac("sha256",secret).update(t+"."+rawBody.toString("utf8")).digest("hex");
  const a = Buffer.from(exp), b = Buffer.from(parts.v1);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

async function markPaid(s){
  const id = s.metadata && s.metadata.order_id; if(!id || !UUID.test(id)) return;
  const rows = await sb(`shop_orders?id=eq.${id}&select=*`); const o = rows[0]; if(!o) return;
  if(o.paid_at) return;                                     /* déjà traité : on ne fait rien de plus */
  const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const cd = s.customer_details || {};
  const late = ["cancelled","expired"].includes(o.status);
  const upd = {status:"paid", paid_at:new Date().toISOString(), email:cd.email||null, name:ship.name||cd.name||null, phone:cd.phone||null,
    address:ship.address||cd.address||null, note: late ? "Paiement reçu après expiration : vérifier la disponibilité des articles." : o.note};
  await sb(`shop_orders?id=eq.${id}`,{method:"PATCH",body:upd});
  const ids = (o.items||[]).map(i=>i.id).filter(i=>UUID.test(i));
  if(ids.length) await sb(`products?id=${inList(ids)}`,{method:"PATCH",body:{status:"sold"}});
  await notify(Object.assign({},o,upd));
}
async function markExpired(s){
  const id = s.metadata && s.metadata.order_id; if(!id || !UUID.test(id)) return;
  const rows = await sb(`shop_orders?id=eq.${id}&select=*`); const o = rows[0];
  if(!o || o.status!=="pending") return;
  await sb(`shop_orders?id=eq.${id}`,{method:"PATCH",body:{status:"expired"}});
  await release((o.items||[]).map(i=>i.id).filter(i=>UUID.test(i)));
}

async function webhook(req, res){
  const body = await raw(req);
  if(!verifySignature(body, req.headers["stripe-signature"], env("STRIPE_WEBHOOK_SECRET"))) return send(res,400,{error:"Signature invalide."});
  const ev = JSON.parse(body.toString("utf8"));
  const s = ev.data && ev.data.object;
  try{
    if((ev.type==="checkout.session.completed" && s.payment_status==="paid") || ev.type==="checkout.session.async_payment_succeeded") await markPaid(s);
    else if(ev.type==="checkout.session.expired" || ev.type==="checkout.session.async_payment_failed") await markExpired(s);
  }catch(e){ console.error(e.message); return send(res,500,{error:"Erreur de traitement."}); }
  return send(res,200,{received:true});
}

async function status(url, res){
  const o = url.searchParams.get("o") || ""; if(!UUID.test(o)) return send(res,400,{error:"Commande inconnue."});
  const r = await sb(`shop_orders?id=eq.${o}&select=number,status,paid_at`);
  if(!r[0]) return send(res,404,{error:"Commande inconnue."});
  return send(res,200,{number:r[0].number,status:r[0].status,paid:!!r[0].paid_at});
}
async function track(url, res){
  const n = (url.searchParams.get("n")||"").trim().toUpperCase(), em = (url.searchParams.get("email")||"").trim().toLowerCase();
  if(!/^TR-[A-Z0-9]{6}$/.test(n) || !em) return send(res,400,{error:"Indique ton numéro de commande et ton e-mail."});
  const r = await sb(`shop_orders?number=eq.${n}&select=number,status,email,items,subtotal_cents,shipping_cents,total_cents,created_at,paid_at,shipped_at,delivered_at,carrier,tracking_number`);
  const o = r[0];
  if(!o || !o.email || o.email.toLowerCase()!==em) return send(res,404,{error:"Aucune commande ne correspond à ces informations."});
  const pick = {};
  ["number","status","subtotal_cents","shipping_cents","total_cents","created_at","paid_at","shipped_at","delivered_at","carrier","tracking_number"].forEach(k=>pick[k]=o[k]);
  pick.items = (o.items||[]).map(i=>({title:i.title,size:i.size,price_cents:i.price_cents,photo:i.photo}));
  return send(res,200,pick);
}
async function cancel(req, res){
  let body; try{ body = JSON.parse((await raw(req)).toString()||"{}"); }catch(e){ return send(res,400,{error:"Requête invalide."}); }
  if(!UUID.test(body.o||"")) return send(res,400,{error:"Commande inconnue."});
  const r = await sb(`shop_orders?id=eq.${body.o}&select=*`); const o = r[0];
  if(o && o.status==="pending"){
    if(o.stripe_session) await stripe("POST",`/checkout/sessions/${o.stripe_session}/expire`).catch(()=>{});
    await sb(`shop_orders?id=eq.${o.id}`,{method:"PATCH",body:{status:"cancelled"}});
    await release((o.items||[]).map(i=>i.id).filter(i=>UUID.test(i)));
  }
  return send(res,200,{ok:true});
}

async function handler(req, res){
  try{
    const url = new URL(req.url,"http://x"), action = url.searchParams.get("action");
    if(action==="config" && req.method==="GET") return send(res,200,await config());
    if(action==="checkout" && req.method==="POST") return await checkout(req,res);
    if(action==="webhook" && req.method==="POST") return await webhook(req,res);
    if(action==="status" && req.method==="GET") return await status(url,res);
    if(action==="track" && req.method==="GET") return await track(url,res);
    if(action==="cancel" && req.method==="POST") return await cancel(req,res);
    return send(res,404,{error:"Action inconnue."});
  }catch(e){ console.error(e.message); return send(res,500,{error:"Erreur serveur."}); }
}
module.exports = handler;
module.exports._t = {SETTINGS, weightOf, shippingFor, verifySignature};
