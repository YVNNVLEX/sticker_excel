# Etiquettes UI (Next.js)

Interface web pour la recherche produits et la gestion/Impression des Clients Club Card via Odoo (JSON-RPC).

## Prerequis
- Node.js 18+ (recommande)
- npm

## Installation
Depuis le dossier `web` :

```bash
npm install
```

## Lancer le serveur (dev)
```bash
npm run dev
```

Ouvrir http://localhost:3000

## Build & Start (prod)
```bash
npm run build
npm run start
```

## Utilisation de l'interface
1) Connexion Odoo  
   - Renseigner `Base URL`, `DB`, `Username`, `Password`.
   - Utiliser l'URL racine Odoo (ex: `https://mon-odoo.com` sans `/web`).
   - La config est sauvegardee en session (sessionStorage).

2) Recherche produits  
   - Entrer un EAN / reference / nom.
   - Les prix Club/Public sont calcules via l'API Odoo.

3) Clients Club Card  
   - Bouton **Charger depuis Odoo** pour charger la premiere page.
   - Recherche serveur via le champ "Recherche Odoo".
   - Pagination via **Charger +10**.
   - Impression par ligne (bouton **Imprimer**) : nom + barcode (CODE128) + code.
   - Si popup bloquee, l'impression bascule sur un iframe cache.

## Scripts utiles
```bash
npm run dev     # dev server
npm run build   # build prod
npm run start   # run prod
npm run lint    # lint
```

## Points techniques
- Routes API Odoo :
  - `app/api/odoo/search` (recherche produits)
  - `app/api/odoo/club-card` (clients Club Card, pagination + recherche)
- Impression Club Card :
  - `lib/club-card/print.ts`
- Types/utilitaires :
  - `lib/club-card/types.ts`
  - `lib/utils/format.ts`
  - `lib/odoo/constants.ts`

## Troubleshooting
- **Popup bloque** : autoriser les popups pour l'impression.
- **Erreur Odoo** : verifier l'URL racine et les identifiants.
- **Recherche Club Card vide** : verifier le modele expose et les champs disponibles (route `club-card` loggue le modele/fields en dev).
