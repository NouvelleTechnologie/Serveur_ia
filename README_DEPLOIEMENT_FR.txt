DIGICOM TOGO — SERVEUR IA (BACKEND) POUR RENDER
================================================

CE DOSSIER EST LE BACKEND IA SEUL.
Il ne remplace pas le frontend DigiCom Admin publié sur GitHub Pages.

DÉPLOIEMENT RENDER
1. Créer un nouveau service Web sur Render, connecté au dépôt Git contenant ce dossier.
2. Si ce dossier est à la racine du dépôt : laisser Root Directory vide.
   S'il est dans un sous-dossier nommé DigiCom_BACKEND_IA : indiquer ce nom comme Root Directory.
3. Runtime : Node.
4. Build Command : npm install
5. Start Command : npm start
6. Déployer le service et attendre la fin du déploiement.

VARIABLES D'ENVIRONNEMENT À AJOUTER DANS RENDER (Environment)
OPENAI_API_KEY                = la clé API OpenAI (secret)
FIREBASE_PROJECT_ID           = digicom-togo-6d3ea
FIRESTORE_DATABASE_ID         = default
FRONTEND_ORIGIN               = https://nouvelletechnologie.github.io
OPENAI_TEXT_MODEL             = gpt-4.1-mini
OPENAI_IMAGE_MODEL            = gpt-image-2.5-sunburst
FIREBASE_SERVICE_ACCOUNT_JSON = contenu JSON complet du compte de service Firebase

IMPORTANT SÉCURITÉ
- Ne jamais mettre OPENAI_API_KEY ou FIREBASE_SERVICE_ACCOUNT_JSON dans le frontend.
- Ne jamais envoyer le fichier de compte de service à GitHub ou dans un ZIP public.
- Vérifier que le compte de service appartient au projet Firebase digicom-togo-6d3ea
  et dispose des droits nécessaires pour vérifier les jetons et lire Firestore.
- Ce backend vérifie le jeton Firebase et le rôle/abonnement avant les appels IA.
- Le quota actuellement présent dans le code est une limitation temporaire en mémoire
  du processus Render, pas un quota mensuel durable.

TEST APRÈS DÉPLOIEMENT
Ouvrir dans Chrome : https://ADRESSE-RENDER.onrender.com/api/health
Le JSON doit afficher :
  ok: true
  service: "digicom-ai"
  openaiConfigured: true
  firebaseAdminConfigured: true
  configured: true
Si configured vaut false, vérifier les variables Render.

RACCORDEMENT FRONTEND
Dans la configuration du frontend DigiCom Admin, renseigner l'URL HTTPS exacte du service
Render comme URL de l'API IA (sans ajouter /api/health).
Les routes exposées sont :
  GET  /api/health
  POST /api/generate-description
  POST /api/improve-image

Le backend ne sert pas les pages HTML de l'administration : celles-ci restent sur GitHub Pages.
