# 🏠 AppColoc

Petite web app pour gérer la coloc, partagée entre tous les colocs :

- **🛒 Courses** : liste de choses à acheter, avec qui a demandé et qui a acheté.
- **✅ Tâches** : tâches ponctuelles ou récurrentes (chaque jour / semaine / 2 semaines / mois),
  assignées à un coloc, avec rotation automatique entre les colocs actuels.
- **💸 Tricount** : un bouton vers le Tricount de la coloc (lien modifiable dans l'app).
- **👥 Colocs** : liste dynamique. Un coloc qui part passe dans « Anciens colocs »
  (l'historique garde son nom) et ses tâches récurrentes passent au suivant.

## Comment ça marche

- La page est hébergée sur **GitHub Pages** (fichiers statiques à la racine du dépôt).
- Les données sont dans **Supabase** (base PostgreSQL gratuite). La page appelle uniquement
  les fonctions définies dans [`supabase/schema.sql`](supabase/schema.sql).
- Les tables sont fermées au public : chaque fonction vérifie le **code de la coloc**.
  Le code est demandé une fois par téléphone puis mémorisé.

## Installer sur iPhone

Ouvrir le lien GitHub Pages dans **Safari** → bouton Partager → **« Sur l'écran d'accueil »**.

## Mise en place (une seule fois)

1. Créer un projet sur [supabase.com](https://supabase.com).
2. Dans Supabase → **SQL Editor**, coller tout `supabase/schema.sql` et cliquer **Run**.
3. Choisir le code de la coloc, toujours dans le SQL Editor :
   ```sql
   select _set_code('le-code-de-la-coloc');
   ```
   (Même commande pour changer le code plus tard : chaque téléphone devra entrer le nouveau.)
4. Mettre l'URL du projet et la clé *publishable* (Project Settings → API) dans `config.js`.

## Tester en local

```bash
python3 -m http.server 8000
```
puis ouvrir http://localhost:8000.
