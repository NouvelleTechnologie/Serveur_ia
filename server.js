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
// Firestore : la base par défaut s'appelle "(default)" avec parenthèses
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

// --- CORS : GitHub Pages ---
function normaliserOrigine(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
const originesEnv = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map((v) => normaliserOrigine(v.trim())).filter(Boolean);
const originesDefaut = [
  'https://nouvelletechnologie.github.io',
  'http://localhost:5173',
  'http://localhost:3000'
];
const originesAutorisees = new Set(originesEnv.length ? originesEnv : originesDefaut);

app.use(cors({
  origin(origin, callback) {
    if (!origin || originesAutorisees.has(normaliserOrigine(origin))) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
}));
app.use(express.json({ limit: '22mb' }));
app.disable('x-powered-by');

// --- Firebase Admin ---
let adminAuth = null;
let adminDb = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const account = JSON.parse(raw);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
    const adminApp = getAdminApps().find((i) => i.name === 'digicom-admin')
      || initializeAdminApp({ credential: cert(account), projectId: PROJECT_ID }, 'digicom-admin');
    adminAuth = getAdminAuth(adminApp);
    adminDb = FIRESTORE_DATABASE_ID === '(default)'
      ? getAdminFirestore(adminApp)
      : getAdminFirestore(adminApp, FIRESTORE_DATABASE_ID);
    console.log('Firebase Admin OK - base:', FIRESTORE_DATABASE_ID);
  } else {
    console.log('Firebase Admin NON configure : FIREBASE_SERVICE_ACCOUNT_JSON manquant');
  }
} catch (e) {
  console.error('Firebase Admin non initialise :', e?.message || e);
}

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
if (!client) console.log('OpenAI NON configure : OPENAI_API_KEY manquant');
else console.log('OpenAI OK');

function dateMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

async function verifierAbonne(req, res, next) {
  if (!adminAuth || !adminDb) {
    return res.status(503).json({ error: "Serveur IA non configure sur Render (FIREBASE_SERVICE_ACCOUNT_JSON)." });
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
      return res.status(403).json({ error: "Fonction IA reservee aux vendeurs abonnes actifs." });
    }
    const aboSnap = await adminDb.collection('abonnements').doc(decoded.uid).get();
    if (!aboSnap.exists) return res.status(403).json({ error: "Aucun abonnement vendeur n'est enregistre." });
    const abo = aboSnap.data();
    if (abo.actif === false || dateMillis(abo.dateFin) <= Date.now()) {
      return res.status(403).json({ error: 'Ton abonnement DigiCom est expire ou inactif.' });
    }
    req.digicomUser = { uid: decoded.uid, nom: profile.nom || profile.email || 'Vendeur' };
    return next();
  } catch (e) {
    console.error('Verification token :', e?.message || e);
    return res.status(401).json({ error: 'Session DigiCom invalide ou expiree. Deconnecte-toi puis reconnecte-toi.' });
  }
}

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
      return res.status(429).json({ error: 'Limite temporaire atteinte. Reessaie dans quelques minutes.' });
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
    if (!client) return res.status(503).json({ error: "OPENAI_API_KEY non configuree sur Render." });
    const { nom, prix, categorie, details } = req.body || {};
    if (typeof nom !== 'string' || nom.trim().length < 2 || nom.trim().length > 120) {
      return res.status(400).json({ error: 'Le nom du produit doit contenir de 2 a 120 caracteres.' });
    }
    if (details != null && (typeof details !== 'string' || details.length > 1200)) {
      return res.status(400).json({ error: 'Details trop longs (max 1200 caracteres).' });
    }
    const result = await client.responses.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
      instructions: 'Redige en francais une description de produit pour une marketplace locale au Togo, environ 40 a 90 mots. Sois clair et attractif sans inventer de marque, qualite certifiee, origine, garantie, ingredients, dimensions, stock, proprietes medicales ou caracteristiques non fournies. Ne modifie pas le prix. Retourne uniquement la description.',
      input: `Nom : ${nom.trim()}\nPrix indique : ${String(prix ?? 'non precise').slice(0, 40)}\nCategorie : ${String(categorie ?? 'non precisee').slice(0, 100)}\nDetails confirmes : ${String(details ?? 'aucun').slice(0, 1200)}`
    });
    const description = (result.output_text || '').trim();
    if (!description) return res.status(502).json({ error: 'Aucune description retournee. Reessaie.' });
    return res.json({ description });
  } catch (e) {
    console.error('generate-description:', e?.status || '', e?.message || e);
    return res.status(502).json({ error: "Le moteur de description IA n'a pas pu traiter la demande. Verifie la cle API et les credits OpenAI." });
  }
});

app.post('/api/improve-image', verifierAbonne, limiterIA(5), async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "OPENAI_API_KEY non configuree sur Render." });
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
        : 'Ameliore uniquement la lumiere, le cadrage et la nettete de la photo du produit. Preserve fidelement le produit reel, sa forme, sa couleur, son logo et tous ses details. N’ajoute et ne retire aucun element.')
        .slice(0, 2000),
      size: '1024x1024'
    });
    const base64 = imageResponse.data?.[0]?.b64_json;
    if (!base64) return res.status(502).json({ error: "Aucune image amelioree retournee." });
    return res.json({ imageDataUrl: `data:image/png;base64,${base64}` });
  } catch (e) {
    console.error('improve-image:', e?.status || '', e?.message || e);
    return res.status(502).json({ error: "Le moteur d'image IA n'a pas pu traiter cette photo. Verifie la cle API, les credits et le modele." });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Image trop volumineuse. Maximum 12 Mo.' });
  console.error('Erreur serveur DigiCom IA:', error?.message || error);
  return res.status(500).json({ error: 'Erreur interne du serveur DigiCom IA.' });
});

app.listen(port, '0.0.0.0', () => console.log(`DigiCom AI ecoute sur le port ${port}`));
