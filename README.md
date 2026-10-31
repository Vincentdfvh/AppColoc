# 🏠 AppColoc

Petite web app pour gérer la coloc, partagée entre tous les colocs :

- **🛒 Courses** : liste de choses à acheter, avec qui a demandé et qui a acheté.
- **✅ Tâches** : tâches ponctuelles ou récurrentes (chaque jour / semaine / 2 semaines / mois),
  assignées à un coloc, avec rotation automatique entre les colocs actuels.
- **💸 Tricount** : un bouton vers le Tricount de la coloc (lien modifiable dans l'app).
- **👥 Colocs** : liste dynamique. Un coloc qui part passe dans « Anciens colocs »
  (l'historique garde son nom) et ses tâches récurrentes passent au suivant.

## Lancer l'app

Il faut Node.js 22.13 ou plus récent (aucune dépendance à installer).

```bash
npm start
```

Le terminal affiche deux adresses :

- `http://localhost:3000` pour ce Mac ;
- `http://192.168.x.x:3000` pour les téléphones des colocs **connectés au même wifi**.

Sur iPhone : ouvrir l'adresse dans Safari → Partager → « Sur l'écran d'accueil » pour l'avoir comme une app.

Chaque appareil choisit « Je suis … » en haut de la page ; c'est utilisé pour savoir qui ajoute, achète ou fait quoi.

## Données

Tout est enregistré dans `data/coloc.db` (SQLite, ignoré par git). Pour sauvegarder, copier ce fichier.
Variables utiles : `PORT` (défaut 3000) et `DB_PATH`.

## Limites

- Pas de mot de passe : toute personne sur le wifi qui connaît l'adresse peut modifier les listes.
- L'app n'est accessible que quand le serveur tourne. Pour qu'elle marche en permanence et hors du wifi,
  il faut la mettre sur un serveur toujours allumé (Raspberry Pi, petit VPS, Fly.io, Railway…).
