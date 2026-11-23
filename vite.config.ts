// Configuration de Vite : l'outil qui sert l'interface pendant le développement
// (rechargement instantané à chaque modification) et qui la compile pour la production
// (TypeScript + CSS + polices regroupés en fichiers optimisés).
// Utilisé par « npm run dev » (avec le serveur API, voir package.json) et « npm run build ».
import { defineConfig } from 'vite';

// defineConfig ne fait rien de plus à l'exécution : il sert seulement à l'autocomplétion
// et à la vérification des types de cette configuration.
export default defineConfig({
  // Le dossier de l'interface (celui qui contient index.html) est web/, pas la racine du projet.
  root: 'web',
  // build : les fichiers compilés vont dans dist/web (chemin relatif à root, d'où le ../),
  // dossier vidé avant chaque compilation (emptyOutDir). chunkSizeWarningLimit (en ko) relevé
  // à 800 : Leaflet + MapLibre forment un gros fichier, on évite l'avertissement (500 ko par défaut).
  // C'est ce dossier dist/web que le serveur Express sert en production.
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  // Serveur de développement (npm run dev) :
  server: {
    // host: true : écoute sur toutes les interfaces réseau, pour ouvrir l'app depuis un téléphone
    // sur le même Wi-Fi (http://adresse-IP-du-PC:5180). À éviter sur un réseau public.
    host: true,
    // Port de l'interface en développement.
    port: 5180,
    // Proxy : toute requête /api/... reçue par Vite est relayée au serveur Express (port 3180).
    // Pour le navigateur, interface et API ont la même adresse : pas de problème de CORS ni de cookies.
    proxy: { '/api': { target: 'http://localhost:3180' } },
  },
});
