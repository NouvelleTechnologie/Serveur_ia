import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import {
  cert,
  getApps as getAdminApps,
  initializeApp as initializeAdminApp
} from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const app = express();
const port = Number(process.env.PORT || 10000);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'digicom-togo-6d3ea';
// Le frontend Firebase utilise getFirestore(app, 'default') : base nommée "default".
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'default';

function normaliserOrigine(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

const originesEnv = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((v) => normaliserOrigine(v.trim()))
  .filter(Boolean);

const originesDefaut = [
  'https://nouvelletechnologie.github.io',
  'http://localhost:5173',
  'http://localhost:3000'
];
const originesAutorisees = new Set(originesEnv.length ? originesEnv : originesDefaut);

app.use(cors({
  origin(origin, callback) {
    if (!origin || originesAutorisees.has(normaliserOrigine(origin))) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
}));
app.use(express.json({ limit: '18mb' }));
app.disable('x-powered-by');

let adminAuth = null;
let adminDb = null;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const account = JSON.parse(raw);
    if (account.private_key) {
      account.private_key = account.private_key.replace(/\\n/g, '\n');
    }
    if (account.project_id && account.project_id !== PROJECT_ID) {
      throw new Error(`Le compte de service appartient à ${account.project_id}, pas à ${PROJECT_ID}.`);
    }

    const adminApp = getAdminApps().find((item) => item.name === 'digicom-admin')
      || initializeAdminApp(
        { credential: cert(account), projectId: PROJECT_ID },
        'digicom-admin'
      );

    adminAuth = getAdminAuth(adminApp);
    adminDb = FIRESTORE_DATABASE_ID === '(default)'
      ? getAdminFirestore(adminApp)
      : getAdminFirestore(adminApp, FIRESTORE_DATABASE_ID);

    console.log(`Firebase Admin OK - projet: ${PROJECT_ID} - base: ${FIRESTORE_DATABASE_ID}`);
  } else {
    console.log('Firebase Admin non configuré : FIREBASE_SERVICE_ACCOUNT_JSON manquant.');
  }
} catch (error) {
  console.error('Firebase Admin non initialisé :', error?.message || error);
}

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

if (gemini) console.log('Gemini API configurée.');
else console.log('Gemini API non configurée : GEMINI_API_KEY manquante.');

function dateMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function verifierAbonne(req, res, next) {
  if (!adminAuth || !adminDb) {
    return res.status(503).json({
      error: 'Serveur IA non configuré : vérifiez Firebase Admin sur Render.'
    });
  }

  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (!token) {
    return res.status(401).json({ error: 'Connexion DigiCom requise.' });
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const profileSnap = await adminDb.collection('users').doc(decoded.uid).get();

    if (!profileSnap.exists) {
      return res.status(403).json({ error: 'Profil DigiCom introuvable.' });
    }

    const profile = profileSnap.data();
    if (profile.role !== 'abonne' || profile.actif === false) {
      return res.status(403).json({
        error: 'Fonction IA réservée aux vendeurs abonnés actifs.'
      });
    }

    const aboSnap = await adminDb.collection('abonnements').doc(decoded.uid).get();
    if (!aboSnap.exists) {
      return res.status(403).json({
        error: 'Aucun abonnement vendeur enregistré.'
      });
    }

    const abonnement = aboSnap.data();
    if (
      abonnement.actif === false ||
      dateMillis(abonnement.dateFin) <= Date.now()
    ) {
      return res.status(403).json({
        error: 'Votre abonnement DigiCom est expiré ou inactif.'
      });
    }

    req.digicomUser = {
      uid: decoded.uid,
      nom: profile.nom || profile.email || 'Vendeur'
    };
    return next();
  } catch (error) {
    console.error('Vérification du jeton Firebase :', error?.message || error);
    return res.status(401).json({
      error: 'Session DigiCom invalide ou expirée. Déconnectez-vous puis reconnectez-vous.'
    });
  }
}

// Limitation temporaire par utilisateur et par route, conservée en mémoire du processus.
const appels = new Map();
function limiterIA(maximum, fenetreMs = 10 * 60 * 1000) {
  return (req, res, next) => {
    const maintenant = Date.now();
    const cle = `${req.digicomUser?.uid || req.ip}:${req.path}`;
    const ancien = appels.get(cle);

    if (!ancien || maintenant - ancien.debut >= fenetreMs) {
      appels.set(cle, { debut: maintenant, nombre: 1 });
    } else if (ancien.nombre >= maximum) {
      return res.status(429).json({
        error: 'Limite temporaire atteinte. Réessayez dans quelques minutes.'
      });
    } else {
      ancien.nombre += 1;
    }

    // Empêche la Map de grossir sans limite lorsque de nombreux comptes se connectent.
    if (appels.size > 5000) {
      for (const [key, value] of appels) {
        if (maintenant - value.debut >= fenetreMs) appels.delete(key);
      }
    }
    return next();
  };
}

app.get('/', (_req, res) => {
  res.type('text').send('DigiCom Gemini AI service is running.');
});

app.get('/api/health', (_req, res) => {
  const firebaseConfigured = Boolean(adminAuth && adminDb);
  const geminiConfigured = Boolean(gemini);

  res.json({
    ok: true,
    service: 'digicom-ai',
    provider: 'gemini',
    geminiConfigured,
    firebaseAdminConfigured: firebaseConfigured,
    firestoreDatabase: FIRESTORE_DATABASE_ID,
    configured: Boolean(geminiConfigured && firebaseConfigured)
  });
});

app.post('/api/generate-description', verifierAbonne, limiterIA(20), async (req, res) => {
  try {
    if (!gemini) {
      return res.status(503).json({ error: 'GEMINI_API_KEY non configurée sur Render.' });
    }

    const { nom, prix, categorie, details } = req.body || {};

    if (typeof nom !== 'string' || nom.trim().length < 2 || nom.trim().length > 120) {
      return res.status(400).json({
        error: 'Le nom du produit doit contenir de 2 à 120 caractères.'
      });
    }
    if (details != null && (typeof details !== 'string' || details.length > 1200)) {
      return res.status(400).json({ error: 'Détails trop longs (maximum 1 200 caractères).' });
    }

    const prompt = [
      'Tu rédiges des descriptions de produits pour DigiCom, une marketplace locale au Togo.',
      'Écris en français une description claire et attractive de 40 à 90 mots.',
      'N’invente jamais une marque, une certification, une origine, une garantie, des ingrédients,',
      'des dimensions, un stock, des propriétés médicales ou des caractéristiques non fournies.',
      'Ne modifie pas le prix. Retourne uniquement la description du produit.',
      '',
      `Nom du produit : ${nom.trim()}`,
      `Prix indiqué : ${String(prix ?? 'non précisé').slice(0, 40)}`,
      `Catégorie : ${String(categorie ?? 'non précisée').slice(0, 100)}`,
      `Détails confirmés : ${String(details ?? 'aucun').slice(0, 1200)}`
    ].join('\n');

    const result = await gemini.models.generateContent({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
      contents: prompt
    });

    const description = String(result.text || '').trim();
    if (!description) {
      return res.status(502).json({ error: 'Gemini n’a retourné aucune description. Réessayez.' });
    }

    return res.json({ description });
  } catch (error) {
    console.error('generate-description Gemini:', error?.status || '', error?.message || error);
    return res.status(502).json({
      error: 'Gemini n’a pas pu générer la description. Vérifiez la clé API, les quotas et le modèle.'
    });
  }
});

app.post('/api/improve-image', verifierAbonne, limiterIA(5), async (req, res) => {
  try {
    if (!gemini) {
      return res.status(503).json({ error: 'GEMINI_API_KEY non configurée sur Render.' });
    }

    const { imageDataUrl, prompt } = req.body || {};
    const match = typeof imageDataUrl === 'string'
      ? imageDataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i)
      : null;

    if (!match) {
      return res.status(400).json({
        error: 'Envoyez une image PNG, JPEG ou WebP valide.'
      });
    }

    const mimeType = `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`;
    const base64 = match[2].replace(/\s/g, '');
    const bytes = Buffer.from(base64, 'base64');

    if (!bytes.length || bytes.length > 12 * 1024 * 1024) {
      return res.status(413).json({ error: 'La photo doit peser au maximum 12 Mo.' });
    }

    const instruction = (
      typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : 'Améliore uniquement la lumière, le cadrage et la netteté de cette photo de produit. Préserve fidèlement le produit réel, sa forme, sa couleur, son logo, son emballage et tous ses détails. N’ajoute et ne retire aucun élément. Ne remplace pas le produit et ne modifie pas les textes visibles.'
    ).slice(0, 2000);

    const chat = gemini.chats.create({
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image'
    });

    const result = await chat.sendMessage({
      content: [
        { inlineData: { mimeType, data: base64 } },
        instruction,
        'Retourne une image modifiée du même produit. Si tu ne peux pas préserver fidèlement le produit, ne fabrique pas de remplacement.'
      ]
    });

    const parts = result.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.data);

    if (!imagePart) {
      return res.status(502).json({
        error: 'Gemini n’a retourné aucune image modifiée. Réessayez avec une photo plus nette.'
      });
    }

    const outputMime = imagePart.inlineData.mimeType || 'image/png';
    const outputData = imagePart.inlineData.data;
    return res.json({ imageDataUrl: `data:${outputMime};base64,${outputData}` });
  } catch (error) {
    console.error('improve-image Gemini:', error?.status || '', error?.message || error);
    return res.status(502).json({
      error: 'Gemini n’a pas pu traiter cette photo. Vérifiez la clé API, les quotas et le modèle image.'
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image trop volumineuse. Maximum 12 Mo.' });
  }
  console.error('Erreur serveur DigiCom IA :', error?.message || error);
  return res.status(500).json({ error: 'Erreur interne du serveur DigiCom IA.' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`DigiCom Gemini AI écoute sur le port ${port}`);
});
