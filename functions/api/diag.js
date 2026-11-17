export async function onRequest({ env }) {
  const key = env.SUPABASE_SERVICE_KEY || "";
  const out = {
    cle_supabase_longueur: key.length,
    cle_supabase_debut: key.slice(0, 10),
    espace_ou_retour_ligne_dans_cle: /\s/.test(key),
    cle_stripe_debut: (env.STRIPE_SECRET_KEY || "").slice(0, 8),
    webhook_secret_debut: (env.STRIPE_WEBHOOK_SECRET || "").slice(0, 6)
  };
  const base = "https://bteonwvpvlycpghcgceq.supabase.co/rest/v1/";
  for (const [nom, chemin] of [["table_commandes", "shop_orders?select=id&limit=1"], ["table_articles", "products?select=id,weight_g,section&limit=1"]]) {
    try {
      const r = await fetch(base + chemin, { headers: { apikey: key } });
      out[nom] = r.status + " " + (await r.text()).slice(0, 160);
    } catch (e) {
      out[nom] = "ERREUR " + e.message;
    }
  }
  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
}
