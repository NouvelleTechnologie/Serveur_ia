// ia-moteur.js
// Appels IA résilients : délai maximal, réessai, modèles de secours, autres fournisseurs.
// Aucune dépendance externe : le client Gemini et fetch sont fournis par server.js (ou par les tests).

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function listeModeles(principal, secours, parDefaut = '') {
  const liste = [principal, ...String(secours || parDefaut).split(',')]
    .map((m) => String(m || '').trim())
    .filter(Boolean);
  return [...new Set(liste)];
}

export function statutHttp(error) {
  const direct = Number(error?.status ?? error?.code);
  if (Number.isInteger(direct) && direct >= 400 && direct < 600) return direct;
  const m = String(error?.message || '').match(/"code"\s*:\s*(\d{3})/);
  return m ? Number(m[1]) : 0;
}

export function estTemporaire(error) {
  const statut = statutHttp(error);
  if ([408, 429, 500, 502, 503, 504, 529].includes(statut)) return true;
  if (statut === 0) {
    const texte = `${error?.message || ''} ${error?.cause?.code || ''}`;
    return /UNAVAILABLE|overloaded|high demand|ECONNRESET|ETIMEDOUT|fetch failed|timeout|délai/i.test(texte);
  }
  return false;
}

export function reponseErreur(error, contexte) {
  const statut = statutHttp(error);
  const message = String(error?.message || '');
  if (error?.configuration) {
    return { http: 503, retryable: false, error: 'Service IA non configuré sur le serveur (clé API manquante).' };
  }
  if (error?.contenu) {
    return {
      http: 422,
      retryable: false,
      error: 'L’IA n’a pas pu traiter cette photo (image refusée ou illisible). Essayez une autre photo.'
    };
  }
  if (statut === 429) {
    return { http: 429, retryable: true, error: 'Quota IA atteint pour le moment. Réessayez dans quelques minutes.' };
  }
  if (estTemporaire(error)) {
    return {
      http: 503,
      retryable: true,
      error: 'Le service IA est momentanément saturé. Réessayez dans quelques instants.'
    };
  }
  if (statut === 401 || statut === 403 || /API key/i.test(message)) {
    return { http: 502, retryable: false, error: 'Clé API IA refusée. Vérifiez les clés sur Render.' };
  }
  if (statut === 404) {
    return {
      http: 502,
      retryable: false,
      error: `Modèle IA introuvable (${contexte}). Vérifiez le nom du modèle sur Render.`
    };
  }
  return { http: 502, retryable: false, error: `L’IA n’a pas pu traiter la demande (${contexte}).` };
}

function erreurHttp(statut, message) {
  return Object.assign(new Error(message || `Erreur HTTP ${statut}`), { status: statut });
}

async function lireJson(reponse) {
  const brut = await reponse.text();
  try {
    return brut ? JSON.parse(brut) : {};
  } catch {
    return { raw: brut.slice(0, 300) };
  }
}

function avecDelai(executer, modele, ms) {
  const controller = new AbortController();
  let minuteur;
  const delai = new Promise((_, rejeter) => {
    minuteur = setTimeout(() => {
      controller.abort();
      rejeter(erreurHttp(504, 'Délai dépassé'));
    }, ms);
  });
  return Promise.race([executer(modele, controller.signal), delai]).finally(() => clearTimeout(minuteur));
}

export function creerMoteur({
  gemini = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  journal = console,
  delaiReessaiMs = 1200
} = {}) {
  async function essayerModeles({ label, modeles, executer, essais = 2, echeance, timeoutMs }) {
    let derniere = null;
    for (const modele of modeles) {
      for (let essai = 1; essai <= essais; essai += 1) {
        const reste = echeance - Date.now();
        if (reste < 1000) throw derniere || erreurHttp(504, 'Délai dépassé');
        try {
          const resultat = await avecDelai(executer, modele, Math.min(timeoutMs, reste));
          return { resultat, modele };
        } catch (error) {
          derniere = error;
          const statut = statutHttp(error);
          journal.error(`${label} [${modele}] essai ${essai}/${essais} :`, statut || '', error?.message || error);
          if (statut === 404 || statut === 429) break; // modèle suivant
          if (!estTemporaire(error)) throw error; // erreur définitive pour ce fournisseur
          if (essai < essais) await pause(delaiReessaiMs * essai);
        }
      }
    }
    throw derniere || erreurHttp(404, 'Aucun modèle configuré');
  }

  // ---- Fournisseurs de texte -------------------------------------------------
  const definitions = {
    gemini: {
      actif: () => Boolean(gemini),
      modeles: listeModeles(
        env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
        env.GEMINI_TEXT_FALLBACK_MODELS,
        'gemini-2.5-flash,gemini-2.5-flash-lite'
      ),
      appeler: async (model, prompt) => {
        const r = await gemini.models.generateContent({ model, contents: prompt });
        return String(r.text || '').trim();
      }
    },
    anthropic: {
      actif: () => Boolean(env.ANTHROPIC_API_KEY),
      modeles: listeModeles(env.ANTHROPIC_MODEL || 'claude-haiku-5-5', env.ANTHROPIC_FALLBACK_MODELS),
      appeler: async (model, prompt, signal) => {
        const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
          signal
        });
        const data = await lireJson(r);
        if (!r.ok) throw erreurHttp(r.status, data?.error?.message || data.raw);
        return (data.content || [])
          .filter((bloc) => bloc.type === 'text')
          .map((bloc) => bloc.text)
          .join('')
          .trim();
      }
    },
    openai: {
      // Tout service compatible OpenAI : Groq, OpenRouter, OpenAI, etc.
      actif: () => Boolean(env.OPENAI_COMPAT_API_KEY && env.OPENAI_COMPAT_MODEL),
      modeles: listeModeles(env.OPENAI_COMPAT_MODEL, env.OPENAI_COMPAT_FALLBACK_MODELS),
      appeler: async (model, prompt, signal) => {
        const base = String(env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.OPENAI_COMPAT_API_KEY}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.6,
            max_tokens: 500
          }),
          signal
        });
        const data = await lireJson(r);
        if (!r.ok) throw erreurHttp(r.status, data?.error?.message || data.raw);
        return String(data?.choices?.[0]?.message?.content || '').trim();
      }
    }
  };

  const ordre = String(env.TEXT_PROVIDER_ORDER || 'gemini,anthropic,openai')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => definitions[n]);

  function fournisseursTexte() {
    return ordre
      .filter((nom) => definitions[nom].actif())
      .map((nom) => ({ nom, modeles: definitions[nom].modeles }));
  }

  async function genererTexte(prompt, { delaiGlobalMs = 45000, timeoutMs = 20000 } = {}) {
    const actifs = ordre.filter((nom) => definitions[nom].actif() && definitions[nom].modeles.length);
    if (!actifs.length) {
      throw Object.assign(new Error('Aucun fournisseur IA configuré'), { configuration: true, status: 503 });
    }

    const echeance = Date.now() + delaiGlobalMs;
    const erreurs = [];

    for (const nom of actifs) {
      const fournisseur = definitions[nom];
      try {
        const { resultat, modele } = await essayerModeles({
          label: `texte/${nom}`,
          modeles: fournisseur.modeles,
          executer: async (m, signal) => {
            const texte = await fournisseur.appeler(m, prompt, signal);
            if (!texte) throw erreurHttp(502, 'Réponse vide');
            return texte;
          },
          echeance,
          timeoutMs
        });
        if (nom !== actifs[0]) journal.log(`texte : fournisseur de secours utilisé (${nom}/${modele}).`);
        return { texte: resultat, fournisseur: nom, modele };
      } catch (error) {
        erreurs.push(error);
        journal.error(`texte/${nom} abandonné :`, error?.message || error);
      }
    }
    throw erreurs.find(estTemporaire) || erreurs[erreurs.length - 1];
  }

  // ---- Image (Gemini uniquement) ---------------------------------------------
  const modelesImage = listeModeles(
    env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    env.GEMINI_IMAGE_FALLBACK_MODELS
  );

  async function genererImage({ mimeType, base64, instruction }, { delaiGlobalMs = 80000, timeoutMs = 60000 } = {}) {
    if (!gemini) {
      throw Object.assign(new Error('Gemini non configuré'), { configuration: true, status: 503 });
    }
    const { resultat, modele } = await essayerModeles({
      label: 'image/gemini',
      modeles: modelesImage,
      executer: async (model) => {
        const r = await gemini.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType, data: base64 } },
                { text: instruction },
                {
                  text: 'Retourne une image modifiée du même produit. Si tu ne peux pas préserver fidèlement le produit, ne fabrique pas de remplacement.'
                }
              ]
            }
          ]
        });
        const parts = r.candidates?.[0]?.content?.parts || [];
        const image = parts.find((p) => p.inlineData?.data);
        if (!image) {
          const raison = r.promptFeedback?.blockReason || r.candidates?.[0]?.finishReason || 'aucune image';
          throw Object.assign(new Error(`Aucune image retournée (${raison})`), { contenu: true, status: 422 });
        }
        return {
          mime: image.inlineData.mimeType || 'image/png',
          data: image.inlineData.data
        };
      },
      echeance: Date.now() + delaiGlobalMs,
      timeoutMs
    });
    return { imageDataUrl: `data:${resultat.mime};base64,${resultat.data}`, fournisseur: 'gemini', modele };
  }

  return { fournisseursTexte, genererTexte, genererImage };
}
