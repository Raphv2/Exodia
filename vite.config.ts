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
    // Adresse d'écoute : par défaut 'localhost', donc l'interface n'est joignable QUE depuis ce PC
    // (rien d'exposé sur le réseau, même sur un Wi-Fi public).
    // Pour tester depuis un téléphone sur le même Wi-Fi, ouvrir volontairement au réseau local :
    //   VITE_HOST=0.0.0.0 npm run dev        (bash, macOS, Linux)
    //   $env:VITE_HOST='0.0.0.0'; npm run dev (PowerShell)
    // puis ouvrir sur le téléphone l'adresse « Network » affichée par Vite (http://IP-du-PC:5180).
    host: process.env.VITE_HOST ?? 'localhost',
    // Port de l'interface en développement.
    port: 5180,
    // Proxy : toute requête /api/... reçue par Vite est relayée au serveur Express (port 3180).
    // Pour le navigateur, interface et API ont la même adresse : pas de problème de CORS ni de cookies.
    proxy: { '/api': { target: 'http://localhost:3180' } },
  },
});
