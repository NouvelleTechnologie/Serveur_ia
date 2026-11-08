import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';
import { cert, getApps as getAdminApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const app = express();
const port = Number(process.env.PORT || 10000);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'digicom-togo-6d3ea';
// Doit correspondre à FIRESTORE_DATABASE_ID dans config.js (ancienne base DigiCom : 'default').
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'default';

// GitHub Pages transmet uniquement l'origine (sans le chemin du dépôt).
function normaliserOrigine(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
const originesEnv = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map((value) => normaliserOrigine(value.trim())).filter(Boolean);
const originesDefaut = [
  'https://nouvelletechnologie.github.io',
  'https://digicom-togo-admin.onrender.com',
  'https://serveur-ia-cx4f.onrender.com/',
  'http://localhost:5173',
  'http://localhost:3000'
];
const originesAutorisees = new Set(originesEnv.length ? originesEnv : originesDefaut);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || originesAutorisees.has(normaliserOrigine(origin))) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '22mb' }));
app.disable('x-powered-by');

// Firebase Admin : le secret de compte de service reste exclusivement sur Render.
let adminApp = null;
let adminAuth = null;
let adminDb = null;
try {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawServiceAccount) {
    const account = JSON.parse(rawServiceAccount);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
    adminApp = getAdminApps().find((item) => item.name === 'digicom-admin')
      || initializeAdminApp({ credential: cert(account), projectId: PROJECT_ID }, 'digicom-admin');
    adminAuth = getAdminAuth(adminApp);
    adminDb = FIRESTORE_DATABASE_ID === '(default)'
      ? getAdminFirestore(adminApp)
      : getAdminFirestore(adminApp, FIRESTORE_DATABASE_ID);
  }
} catch (error) {
  console.error('Firebase Admin non initialisé :', error?.message || error);
}

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function dateMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function verifierAbonne(req, res, next) {
  if (!adminAuth || !adminDb) {
    return res.status(503).json({ error: "L'authentification sécurisée du serveur IA n'est pas configurée sur Render (FIREBASE_SERVICE_ACCOUNT_JSON)." });
  }
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Connexion DigiCom requise.' });
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const profileSnap = await adminDb.collection('users').doc(decoded.uid).get();
    if (!profileSnap.exists) return res.status(403).json({ error: 'Profil DigiCom introuvable.' });
    const profile = profileSnap.data();
    if (profile.role !== 'abonne' || profile.actif === false) {
      return res.status(403).json({ error: "Cette fonction IA est réservée aux vendeurs abonnés actifs." });
    }
    const aboSnap = await adminDb.collection('abonnements').doc(decoded.uid).get();
    if (!aboSnap.exists) return res.status(403).json({ error: "Aucun abonnement vendeur n'est enregistré." });
    const abo = aboSnap.data();
    if (abo.actif === false || dateMillis(abo.dateFin) <= Date.now()) {
      return res.status(403).json({ error: 'Ton abonnement DigiCom est expiré ou inactif.' });
    }
    req.digicomUser = { uid: decoded.uid, nom: profile.nom || profile.email || 'Vendeur' };
    return next();
  } catch (error) {
    console.error('Vérification Firebase du token :', error?.message || error);
    return res.status(401).json({ error: 'Session DigiCom invalide ou expirée. Déconnecte-toi puis reconnecte-toi.' });
  }
}

// Limitation locale simple pour réduire les abus (à compléter par un quota durable si nécessaire).
const appels = new Map();
function limiterIA(maximum, fenetreMs = 10 * 60 * 1000) {
  return (req, res, next) => {
    const cle = `${req.digicomUser?.uid || req.ip}:${req.path}`;
    const maintenant = Date.now();
    const ancien = appels.get(cle);
    if (!ancien || maintenant - ancien.debut >= fenetreMs) {
      appels.set(cle, { debut: maintenant, nombre: 1 });
      return next();
    }
    if (ancien.nombre >= maximum) {
      return res.status(429).json({ error: 'Limite temporaire atteinte. Réessaie dans quelques minutes.' });
    }
    ancien.nombre += 1;
    return next();
  };
}

app.get('/', (_req, res) => res.type('text').send('DigiCom AI service is running.'));
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'digicom-ai',
    openaiConfigured: Boolean(client),
    firebaseAdminConfigured: Boolean(adminAuth && adminDb),
    configured: Boolean(client && adminAuth && adminDb)
  });
});

app.post('/api/generate-description', verifierAbonne, limiterIA(20), async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "La clé OPENAI_API_KEY n'est pas configurée sur Render." });
    const { nom, prix, categorie, details } = req.body || {};
    if (typeof nom !== 'string' || nom.trim().length < 2 || nom.trim().length > 120) {
      return res.status(400).json({ error: 'Le nom du produit doit contenir de 2 à 120 caractères.' });
    }
    if (details != null && (typeof details !== 'string' || details.length > 1200)) {
      return res.status(400).json({ error: 'Les détails sont trop longs (maximum 1 200 caractères).' });
    }
    const result = await client.responses.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
      instructions: 'Rédige en français une description de produit pour une marketplace locale au Togo, environ 40 à 90 mots. Sois clair et attractif sans inventer de marque, qualité certifiée, origine, garantie, ingrédients, dimensions, stock, propriétés médicales ou caractéristiques non fournies. Ne modifie pas le prix. Retourne uniquement la description.',
      input: `Nom : ${nom.trim()}\nPrix indiqué : ${String(prix ?? 'non précisé').slice(0, 40)}\nCatégorie : ${String(categorie ?? 'non précisée').slice(0, 100)}\nDétails confirmés : ${String(details ?? 'aucun').slice(0, 1200)}`
    });
    const description = (result.output_text || '').trim();
    if (!description) return res.status(502).json({ error: 'Aucune description retournée. Réessaie.' });
    return res.json({ description });
  } catch (error) {
    console.error('generate-description:', error?.status || '', error?.message || error);
    return res.status(502).json({ error: "Le moteur de description IA n'a pas pu traiter la demande. Vérifie la clé API et les crédits OpenAI sur le serveur." });
  }
});

app.post('/api/improve-image', verifierAbonne, limiterIA(5), async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "La clé OPENAI_API_KEY n'est pas configurée sur Render." });
    const { imageDataUrl, prompt } = req.body || {};
    const match = typeof imageDataUrl === 'string'
      ? imageDataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i)
      : null;
    if (!match) return res.status(400).json({ error: 'Envoie une image PNG, JPEG ou WebP valide.' });
    const mime = `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`;
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) {
      return res.status(413).json({ error: 'La photo doit peser au maximum 12 Mo.' });
    }
    const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const imageFile = await toFile(bytes, `produit.${extension}`, { type: mime });
    const imageResponse = await client.images.edit({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst',
      image: imageFile,
      prompt: (typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : 'Améliore uniquement la lumière, le cadrage et la netteté de la photo du produit. Préserve fidèlement le produit réel, sa forme, sa couleur, son logo et tous ses détails. N’ajoute et ne retire aucun élément.')
        .slice(0, 2000),
      size: '1024x1024'
    });
    const base64 = imageResponse.data?.[0]?.b64_json;
    if (!base64) return res.status(502).json({ error: "Aucune image améliorée n'a été retournée par le moteur IA." });
    return res.json({ imageDataUrl: `data:image/png;base64,${base64}` });
  } catch (error) {
    console.error('improve-image:', error?.status || '', error?.message || error);
    return res.status(502).json({ error: "Le moteur d'image IA n'a pas pu traiter cette photo. Vérifie la clé API, les crédits et le modèle configuré sur Render." });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Image trop volumineuse. Maximum 12 Mo.' });
  console.error('Erreur serveur DigiCom IA:', error?.message || error);
  return res.status(500).json({ error: 'Erreur interne du serveur DigiCom IA.' });
});

app.listen(port, '0.0.0.0', () => console.log(`DigiCom AI écoute sur le port ${port}`));
