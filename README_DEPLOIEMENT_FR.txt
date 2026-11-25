DIGICOM TOGO — BACKEND IA GEMINI POUR RENDER
================================================

Ce dépôt contient uniquement le serveur IA. Il ne remplace pas le frontend
DigiCom Admin sur GitHub Pages et ne contient pas la plateforme Acheteur.

DÉPLOIEMENT RENDER
1. Créer ou ouvrir le service Web Render connecté au dépôt de ce backend.
2. Root Directory : laisser vide si ces fichiers sont à la racine du dépôt.
3. Runtime : Node.
4. Build Command : npm install
5. Start Command : npm start
6. Déployer. Le runtime doit être Node.js 22 ou supérieur.

VARIABLES À AJOUTER DANS RENDER > ENVIRONMENT
GEMINI_API_KEY                 Clé API créée dans Google AI Studio
FIREBASE_PROJECT_ID            digicom-togo-6d3ea
FIRESTORE_DATABASE_ID          default
FRONTEND_ORIGIN                https://nouvelletechnologie.github.io
GEMINI_TEXT_MODEL              gemini-2.5-flash
GEMINI_IMAGE_MODEL             gemini-2.5-flash-image
FIREBASE_SERVICE_ACCOUNT_JSON  JSON complet du compte de service Firebase

SÉCURITÉ
- Ne jamais mettre GEMINI_API_KEY ou FIREBASE_SERVICE_ACCOUNT_JSON dans GitHub,
  dans le frontend ou dans un ZIP public.
- Ajouter les deux secrets uniquement dans les variables d'environnement Render.
- Le compte de service doit appartenir au projet digicom-togo-6d3ea.
- Le backend vérifie le jeton Firebase, le rôle "abonne", le profil actif et
  l'existence/l'expiration de l'abonnement avant chaque opération IA.
- Le frontend actuel utilise la base Firestore nommée "default". La variable
  FIRESTORE_DATABASE_ID doit donc rester "default", sauf changement du frontend.
- Le quota dans ce serveur est une limite temporaire en mémoire du processus
  Render, pas un quota mensuel persistant.

ROUTES
GET  /api/health
POST /api/generate-description
POST /api/improve-image

TEST
Ouvrir https://VOTRE-SERVICE.onrender.com/api/health
La réponse doit contenir :
  "ok": true
  "provider": "gemini"
  "geminiConfigured": true
  "firebaseAdminConfigured": true
  "firestoreDatabase": "default"
  "configured": true

Si "configured" vaut false, vérifier les variables Render. Ne pas publier les
valeurs secrètes pour demander de l'aide.

RACCORDEMENT AU FRONTEND ADMIN
Dans le fichier index.html du frontend DigiCom Admin, renseigner l'URL HTTPS
exacte du service Render dans window.DIGICOM_AI_API_URL, sans ajouter
/api/health. Exemple de forme :
window.DIGICOM_AI_API_URL = 'https://nom-du-service.onrender.com';

Le frontend utilise déjà les routes /api/generate-description et
/api/improve-image. Le backend renvoie { description } et { imageDataUrl }.

LIMITES À CONNAÎTRE
- Le contrôle d'abonnement repose sur users/{uid}.role, users/{uid}.actif,
  abonnements/{uid}.actif et abonnements/{uid}.dateFin, comme dans le backend
  d'origine. Il faut confirmer que ces champs correspondent aux données réelles
  du projet Firebase avant le test vendeur.
- Les limites d'appels sont en mémoire et seront réinitialisées lors d'un
  redémarrage Render. Pour une production à grande échelle, prévoir un quota
  persistant.
- Le traitement d'image Gemini est génératif : il faut comparer le résultat à
  l'original avant de publier le produit, même avec les consignes de fidélité.
