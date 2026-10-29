# Ebale · Eaux du Congo

Carte interactive des parcours en pirogue sur le fleuve Congo et les rivières de Kinshasa. Les tracés suivent le vrai cours d'eau (OpenStreetMap). Pour chaque étape, une vue 3D temps réel montre l'eau du fleuve, avec une pirogue et ses pagayeurs.

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

Paramètres d'URL : `?parcours=pool-malebo` ouvre un parcours, et `&3d` ouvre directement la vue 3D.

## Piloter la pirogue

Dans la fiche d'un parcours, la case **Piloter la pirogue** permet de choisir une étape de départ et une étape d'arrivée, puis **Prendre la barre**. Exemple : Beach Ngobila → Port de Brazzaville. **Pilotage libre** lâche la pirogue à l'étape de départ, sans arrivée.

| Commande | Clavier | Écran tactile |
|---|---|---|
| Gaz (manette, reste en place) | Z / W / ↑ | ▲ |
| Ralentir, puis marche arrière | S / ↓ | ▼ |
| Barrer | Q / A / ← et D / → | ◀ ▶ |
| Couper les gaz | Espace | ■ |
| Caméra (poursuite, à bord, orbite) | C | bouton en haut |
| Accélérer le temps | — | ×1 ×4 ×10 ×30 |

- **Le courant.** Il est fort au milieu du fleuve et faible près des berges. Une traversée doit donc viser en amont, sinon la pirogue est déportée vers l'aval. À contre-courant, mieux vaut longer les berges.
- **Obstacles.** Les berges et les rochers arrêtent la pirogue. Pour repartir, il faut reculer.
- **Arrivée.** Un ponton et un drapeau de la RDC marquent l'arrivée.
- **Carte réelle.** La pirogue et sa trace (en jaune) avancent en même temps sur la carte, et le petit plan en haut à droite montre le trajet.
- **Traversée.** Le décor 3D est un chenal droit. Le trajet réel est décomposé dans le sens du courant et en travers, et la largeur est ajustée à celle du fleuve modélisé.
- **Trajet le long d'une rivière.** Le trajet suit le tracé OSM du parcours. Un long bief est condensé, jusqu'à 12 fois, pour tenir dans le décor. Le HUD affiche toujours la distance et le temps réels.

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

**Carte** (`src/map.js`)
- Fond vectoriel OpenFreeMap, libellés en français quand OSM les a, imagerie satellite Esri en option.
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
  - Le mode « À bord » met la caméra à la place du pagayeur arrière.
- Pirogues et jacinthes d'eau flottent sur la même fonction de vagues, évaluée sur le CPU.

Sept ambiances sont disponibles (`src/water/presets.js`) : ville (Kinshasa–Brazzaville), Pool Malebo, rapides, fleuve en forêt équatoriale, rivière sous les arbres, chutes, estuaire et mangroves.

## Crédits

Données © contributeurs OpenStreetMap (ODbL) · Tuiles OpenFreeMap / OpenMapTiles · Imagerie © Esri, Maxar, Earthstar Geographics · Rendu inspiré d'Ultra-Water (MIT).
