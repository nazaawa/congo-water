# Ebale · Eaux du Congo

Jeu de pirogue sur le fleuve Congo et les rivières de Kinshasa. Les tracés suivent le vrai cours d'eau (OpenStreetMap), et l'eau, les pirogues et leurs pagayeurs sont rendus en 3D temps réel.

Le jeu a trois écrans :
- **L'écran titre**, devant le fleuve en 3D temps réel : une pirogue de pêche au coucher du soleil, la caméra qui se balance doucement. Le menu propose **Jouer**, **Course**, **Visite guidée** et **Comment jouer** (souris, ou ↑ ↓ et Entrée). Une affiche pré-rendue du même plan (`public/img/accueil.jpg`, et `accueil-portrait.jpg` sur téléphone) s'affiche le temps que la 3D se charge.
- **La carte du fleuve**, en plein écran, sur l'imagerie satellite. Les huit expéditions sont des cartes en bas de l'écran, avec la forme du tracé et la force du courant. Choisir une carte ouvre sa fiche : l'onglet **Jouer** pour le mode, le trajet et les conditions, l'onglet **Le parcours** pour survoler le tracé et voir chaque étape en 3D.
- **Le voyage**, en 3D plein écran avec le HUD de pilotage. **Quitter** ramène à la carte.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # site statique dans dist/
npm run geo        # (optionnel) re-télécharge les tracés OSM et recalcule les parcours
```

Pour remplacer un modèle, recompresse-le en gardant la hiérarchie. Les noms de nœuds attendus sont `coque_exterieur` et `coque_interieur` pour une pirogue, et `coque`, `plat_bord` et `moteur` pour une baleinière :

```bash
npx @gltf-transform/cli optimize source.glb public/models/pirogue-peche.glb --compress meshopt --flatten false --join-named false --palette false
```

Adresse : `#pool-malebo` (ou `?parcours=pool-malebo`) saute l'écran titre et ouvre directement cette expédition, et `?3d` ouvre directement la vue 3D. L'adresse suit l'expédition ouverte.

## Piloter la pirogue

Dans la fiche d'une expédition, l'onglet **Jouer** permet de choisir un mode, une étape de départ et une étape d'arrivée, puis **Embarquer**.

- **Libre** : **Embarquer**, ou **Pilotage libre** pour partir sans arrivée.
- **Course** : trois équipages rivaux (Requins de Kingabwa, Pagayeurs de Maluku, Étoile de Kinkole…) dans le même bateau que toi. Il y a un compte à rebours 3-2-1, des portes de bouées (+15 s par bouée manquée), un classement en direct, une arche d'arrivée et un tableau des résultats.
- **Visite guidée** : en baleinière peinte de loisirs (18 m) dès que la rivière est assez large. Le pilote automatique suit le lit et ralentit aux étapes, où une fiche s'affiche. Une touche suffit pour prendre la barre, et **P** la rend au pilote.

Dans tous les modes, le nom des étapes flotte au-dessus de leur berge, avec la distance réelle qui reste.

Les **conditions** se choisissent dans le même onglet :
- **Météo** : variable (un orage peut éclater en route, annoncé par le lokolé), beau temps, ou orage dès le départ.
- **Saison** : pluies (hautes eaux, courant plus fort, forêt inondée, plus de jacinthes) ou sèche (basses eaux, bancs de sable qui sortent, courant plus lent).
- **Moment** : matin, midi, coucher ou nuit (lanternes des pêcheurs et des villages, lampe à la proue).

### Le chant des pagayeurs
Sur les pirogues à pagaie, l'équipage chante en appel-réponse : le soliste lance « É-é ya ! Tokende ! » et le chœur répond « O-hé ! Makasi ! ».
- **Z** règle la cadence (le tempo du chant suit).
- **Espace**, ou le gros bouton **Pagaie** sur écran tactile, donne un coup de pagaie. Un coup sur la prise (le coup de tambour) vaut « Malamu ! ».
- Les coups en rythme font monter la combo et poussent la pirogue jusqu'à un tiers plus fort. Si tu laisses passer les temps, l'équipage faiblit.
- Les pagayeurs 3D pagaient sur le tempo du chant.

### Le lokolé
Le tambour à fente des villages du fleuve envoie des messages quand tu passes :
- il salue (« Mbote, Boyei malamu ! ») ;
- il donne la distance de l'étape suivante ;
- il annonce un orage, et la fin de l'orage ;
- il appelle les équipages avant une course.

Le message s'affiche en sous-titre, et le son vient du côté du village. Les villageois qui saluent crient « Mbote ! ». Exemple : Beach Ngobila → Port de Brazzaville.

| Commande | Clavier | Écran tactile |
|---|---|---|
| Gaz (manette, reste en place) | Z / W / ↑ | ▲ |
| Ralentir, puis marche arrière | S / ↓ | ▼ |
| Barrer | Q / A / ← et D / → | ◀ ▶ |
| Couper les gaz | Espace | ■ |
| Caméra (poursuite, à bord, orbite) | C | bouton en haut |
| Pilote automatique (visite) | P | — |
| Coup de pagaie en rythme (pirogues à pagaie) | Espace | bouton Pagaie |
| Couper le son | — | ♪ en haut |
| Accélérer le temps | — | ×1 ×4 ×10 ×30 |

- **Le courant.** Il est fort au milieu du fleuve et faible près des berges. Une traversée doit donc viser en amont, sinon la pirogue est déportée vers l'aval. À contre-courant, mieux vaut longer les berges.
- **Obstacles.** Les berges et les rochers arrêtent la pirogue. Pour repartir, il faut reculer.
- **Arrivée.** Un ponton et un drapeau de la RDC marquent l'arrivée.
- **Carte réelle.** La pirogue et sa trace (en jaune) avancent en même temps sur la carte, et le petit plan en haut à droite montre le trajet.
- **Traversée.** Le décor 3D est un chenal droit. Le trajet réel est décomposé dans le sens du courant et en travers, et la largeur est ajustée à celle du fleuve modélisé.
- **Trajet le long d'une rivière.** La rivière 3D est le vrai tracé OSM entre les deux étapes, avec un peu de rivière avant et après (`src/water/channel.js`).
  - Si le bief est trop long, il est réduit à l'échelle, jusqu'à 12 fois, mais la largeur reste réelle.
  - Les méandres, les virages et l'orientation (nord en haut sur le plan) sont ceux de la carte.
  - Chaque point de la 3D (distance le long du lit, écart au milieu) correspond à un point de la carte.
  - Le HUD affiche toujours la distance et le temps réels.

## Parcours

| Parcours | Distance (tracé OSM) | Embarcation |
|---|---|---|
| Traversée Kinshasa ⇄ Brazzaville | 5 km | Canot rapide |
| Le Pool Malebo en pirogue (tour de l'île Mbamu) | 109 km | Pirogue motorisée |
| Les rapides de Kinshasa (Ngobila → Kinsuka) | 13 km | Pirogue de pêcheurs |
| La Lukaya, Ma Vallée & Lola ya Bonobo | 3 km | Pirogue à la pagaie |
| La rivière N'djili | 25 km | Pirogue à la perche |
| Chutes de Zongo → confluence Inkisi–Congo | 6 km | Excursion |
| Kinshasa → Kisangani | 1 663 km | Baleinière |
| Matadi → Boma → Banana | 145 km | Bateau / vedette |

Les étapes et leurs coordonnées sont dans `src/data/routes.js` (vérifiées avec Nominatim/OSM). Pour ajouter un parcours, il suffit d'y ajouter une entrée (`river` = nom OSM de la rivière, `waypoints` pour guider le tracé), puis de lancer `npm run geo`.

## Comment c'est fait

**Tracés réels** (`scripts/build-geo.mjs`)
- Requêtes Overpass pour le fleuve Congo (de l'estuaire à Kisangani), les rivières de Kinshasa et l'Inkisi.
- Un graphe par rivière, construit à partir des voies OSM. Les extrémités qui ne se touchent pas sont raccordées si l'écart est inférieur à un seuil.
- Dijkstra entre les points de passage, si bien que la ligne suit le lit du fleuve, avec ses bras et ses îles. Elle est ensuite simplifiée (Douglas-Peucker) et écrite dans `public/data/*.geojson`.

**Écrans** (`src/main.js`, `src/style.css`)
- L'écran titre réutilise la vue 3D du jeu, derrière le texte : le mode caméra `hero` de `RiverScene` regarde le soleil bas par-delà la pirogue, et `setFraming` décale l'image pour laisser la place au titre (à droite sur ordinateur, au-dessus du menu sur téléphone). En fond d'écran, la 3D est rendue en résolution réduite, et elle s'arrête dès qu'on passe à la carte.
- Titres en Fraunces, interface en Barlow et Barlow Condensed, panneaux sombres à coins dorés, boutons biseautés.

**Carte** (`src/map.js`)
- Imagerie satellite Esri par défaut (les noms de routes et les points d'intérêt sont masqués), fond vectoriel OpenFreeMap au choix, libellés en français quand OSM les a.
- Si le fond de carte est injoignable (hors ligne, ou dans un cadre qui bloque les autres sites), la carte passe sur un sol nu : le fleuve, les rivières et les parcours restent, car ce sont les données du jeu.
- Une pirogue avance le long du tracé, à la vitesse typique de l'embarcation, en temps accéléré.
- Quand elle passe une étape, la vue 3D change d'ambiance.

**Eau 3D** (`src/water/`), dans l'esprit d'[Ultra-Water](https://github.com/Humpalumps/Ultra-Water) (MIT), ré-écrit pour une rivière :
- Grille polaire centrée sur la caméra.
- Vagues de Gerstner transportées par le courant. Dans les rapides, des vagues stationnaires (ω = kU) gardent leurs crêtes immobiles pendant que l'eau les traverse, et s'éteignent dans les eaux calmes près des berges.
- Rides advectées par un « flow map » à deux phases, plus des panaches de sédiments dans la couleur brune du fleuve.
- Réflexion planaire des berges et des bateaux, Fresnel, soleil GGX avec scintillement, et lueur à contre-jour sur les crêtes.
- Écume qui s'érode (pleine, puis trouée, puis dentelle) : sur les crêtes, autour des rochers, au pied des chutes.
- Ciel analytique tropical et brumeux, partagé avec le brouillard et les reflets.
- Embarcations 3D (`public/models/`) : pirogues de transport 12 m, de pêche 8 m, petite 4,5 m, et baleinières en planches de 16 m (à passagers, chargée de sacs, chargée de bois).
  - Modèles GLB fournis, compressés avec meshopt (pirogues 8 Mo → 1,3 Mo, baleinières 9,4 Mo → 0,9 Mo).
  - Sur les baleinières, le moteur « long-tail » du modèle pivote quand on barre. Le barreur se tient debout sur le banc arrière, et les passagers s'assoient sur les bancs ou sur la cargaison.
  - Chaque parcours a sa pirogue par défaut, et on peut en changer dans la vue 3D.
  - Équipage debout à la pagaie, passagers, cargaison (bassines, sacs, régimes), filet sur la pirogue de pêche.
  - D'autres pirogues sont amarrées sur les berges ou pêchent autour.
  - Un « couvercle » invisible, calculé depuis la coque intérieure, empêche l'eau d'apparaître dans la coque.
  - La baleinière peinte de loisirs (18 m) a un toit en raphia, des chaises autour de petites tables, un moteur hors-bord qui pivote, des touristes en gilet et un guide qui salue à la proue.
  - Le mode « À bord » met la caméra dans les yeux du barreur ou du pagayeur arrière.
- **Personnages** (`src/water/people.js`), d'après les piétons de [slop-newyork](https://github.com/mrdoob/slop-newyork) (MIT) de mrdoob :
  - Le corps est « lofté » à partir d'anneaux de super-ellipses, avec un squelette de 15 os, l'IK des bras et des jambes, et la forme féminine, la coiffure et la corpulence en morph targets.
  - Les vêtements sont peints par le shader : pagnes et chemises en wax, rayures, carreaux, maillot des Léopards, gilet de sauvetage orange.
  - Les poses : pagayer, perche, barre, assis, debout, marcher, accroupi, saluer.
  - Les villageois (`villagers.js`) lavent le linge au bord de l'eau, regardent passer les bateaux et les saluent, ou marchent entre les cases. Seuls ceux qui sont près du bateau sont créés.
- **Course et visite** (`src/water/race.js`) : les rivaux suivent une ligne de course dans le repère du lit (milieu du fleuve à la descente, près d'une berge à la remontée), poussés ou freinés par le même courant que toi. La visite guidée utilise le même pilote automatique, qui sait contourner les rochers.
- **Son** (`src/water/audio.js`) : tout est synthétisé en Web Audio, sans aucun fichier son.
  - Le chant : voix à formants, soliste et chœur.
  - Les instruments : ngoma sur chaque prise et likembé entre les temps.
  - Le lokolé : deux langues de bois résonnantes.
  - Les ambiances : eau, forêt (insectes et oiseaux), ville, pluie, vent, nuit (grenouilles et grillons).
  - Le tonnerre et le moteur hors-bord.
- **Fleuve vivant** (`src/water/weather.js`) : l'orage bouche et assombrit le ciel. Les rafales creusent les vagues et poussent le bateau, la pluie tombe en traits autour de la caméra, et le tonnerre gronde quelques secondes après chaque éclair. Pour les saisons, le terrain monte ou descend par rapport à l'eau. La nuit, des lanternes s'allument.
- **Faune** (`src/water/fauna.js`), modèles gratuits optimisés de 4,3 Mo à 150 Ko :
  - Hippopotames en groupe, dos et tête hors de l'eau. Ils plongent quand un bateau approche, et on ne peut pas passer à travers.
  - Crocodiles sur les plages, qui glissent à l'eau.
  - Aigrettes, hérons et tantales ibis qui pêchent au bord de l'eau, puis remontent la berge à ton passage.
  - Poissons qui sautent autour du bateau.
- **Décor** : le long du lit, berges et forêt (géants en parasol, palmiers, jeunes feuilles rouges), papyrus, villages de pêcheurs (cases en torchis, toits de chaume ou de tôle), plages de sable à l'intérieur des méandres, vols d'oiseaux. Les rivières étroites ont un maillage fin qui suit le lit.
- Pirogues et jacinthes d'eau flottent sur la même fonction de vagues, évaluée sur le CPU.

Sept ambiances sont disponibles (`src/water/presets.js`) : ville (Kinshasa–Brazzaville), Pool Malebo, rapides, fleuve en forêt équatoriale, rivière sous les arbres, chutes, estuaire et mangroves.

## Crédits

Données © contributeurs OpenStreetMap (ODbL) · Tuiles OpenFreeMap / OpenMapTiles · Imagerie © Esri, Maxar, Earthstar Geographics · Rendu inspiré d'Ultra-Water (MIT) · Personnages d'après slop-newyork de mrdoob (MIT).

Animaux (`public/models/animaux/`, recompressés avec meshopt et textures WebP) :
- « Hippopotamus », « Crocodile », « Great egret », « Heron » et « Yellow billed stork » par Poly by Google, sous licence [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/), via [Poly Pizza](https://poly.pizza).
- « Fish » par Quaternius, sous licence CC0.
