# Mettre Terrain en ligne sur `carte.raphaelgosset.fr`

L'app tourne sur un petit serveur à toi (VPS). Ton domaine reste chez Hostinger : on y ajoute seulement un sous-domaine qui pointe vers ce serveur. **MyOS sur `raphaelgosset.fr` n'est pas touché.**

Compte environ 30 minutes la première fois. Ensuite, une mise à jour se fait en une commande.

---

## 1. Louer le serveur (VPS)

N'importe quel VPS Linux fait l'affaire. Il suffit de 1 vCPU, 1 à 2 Go de RAM et 20 Go de disque. Quelques exemples (tarifs indicatifs, à vérifier) :

| Hébergeur | Offre | Prix | Remarque |
|---|---|---|---|
| Hetzner | CX22 | ≈ 4–5 €/mois | Datacenters en Allemagne et en Finlande, très fiable |
| OVHcloud | VPS-1 | ≈ 5–7 €/mois | Datacenters en France |
| Hostinger | KVM 1 | ≈ 5–7 €/mois | Même compte que ton domaine |

À la création :
- **Système** : **Ubuntu 24.04**.
- **Clé SSH** : ajoute ta clé publique, c'est plus sûr qu'un mot de passe. Si tu n'en as pas, crée-la dans PowerShell sur ton PC :
  ```powershell
  ssh-keygen -t ed25519
  ```
  puis colle le contenu de `C:\Users\<toi>\.ssh\id_ed25519.pub` dans l'interface de l'hébergeur.
- Les **sauvegardes automatiques** de l'hébergeur sont une option payante (≈ +20 %) mais recommandée : elles conservent une copie en dehors du serveur.

Note l'**adresse IPv4** du serveur, par exemple `203.0.113.42`.

## 2. Créer le sous-domaine dans hPanel (Hostinger)

1. hPanel → **Domaines** → `raphaelgosset.fr` → **DNS / Serveurs de noms**.
2. **Ajouter un enregistrement** :
   - Type : **A**
   - Nom : **carte** (ou un autre nom de ton choix)
   - Pointe vers : **l'IPv4 du VPS**
   - TTL : 300 (ou la valeur par défaut)
3. **Ne modifie aucun autre enregistrement** : ce sont eux qui font fonctionner MyOS et tes e-mails.

La mise à jour prend en général quelques minutes. Pour vérifier, dans PowerShell :
```powershell
nslookup carte.raphaelgosset.fr
```
L'adresse affichée doit être celle de ton VPS.

## 3. Installer l'app

Connecte-toi au serveur depuis PowerShell :
```powershell
ssh root@203.0.113.42
```

Puis, **sur le serveur**, télécharge le script. Tu peux le lire avant de le lancer :
```bash
curl -fsSL https://raw.githubusercontent.com/Raphv2/lfiMap/main/deploy/install.sh -o install.sh
less install.sh
```

Lance-le :
```bash
bash install.sh carte.raphaelgosset.fr
```

### Si le dépôt redevient privé

Le serveur ne peut plus télécharger le script : envoie-le depuis ton PC.
```powershell
scp C:\Users\rgosset\Documents\dev\terrain\deploy\install.sh root@203.0.113.42:
```

Au premier lancement, le script crée alors une *clé de déploiement* propre à ce serveur et l'affiche (une ligne qui commence par `ssh-ed25519`). Puis il attend :

1. Ouvre la page indiquée, `https://github.com/Raphv2/lfiMap/settings/keys/new` (dépôt → Settings → Deploy keys → Add deploy key).
2. **Title** : `serveur carte.raphaelgosset.fr`.
3. **Key** : colle la ligne affichée.
4. **Ne coche pas** « Allow write access » : le serveur peut seulement lire ce dépôt, rien d'autre sur ton compte.
5. Clique sur **Add key**, puis appuie sur Entrée dans le terminal.

Si un jour tu retires cette clé sur GitHub, le serveur ne pourra plus récupérer de mises à jour, mais l'app continuera de tourner.

Le script :
- installe Node.js 22, Caddy (serveur web avec HTTPS automatique) et le pare-feu ;
- crée un utilisateur système `terrain` sans droits, qui fait tourner l'app ;
- récupère le code depuis GitHub et compile l'interface ;
- démarre l'app, et la relance automatiquement si elle plante ou si le serveur redémarre ;
- programme une sauvegarde chaque nuit à 4 h, conservée 14 jours ;
- active les mises à jour de sécurité automatiques d'Ubuntu.

À la fin, il affiche un **lien pour devenir admin**, valable 24 h et utilisable une seule fois. **Ouvre-le sur ton téléphone** : cet appareil devient l'admin. Ensuite, tu fais entrer les autres avec des QR codes depuis l'onglet **Équipe**.

> Le lien ne s'est pas affiché, ou tu l'as perdu avant de l'ouvrir ?
> ```bash
> cd /opt/terrain && sudo -u terrain env DATA_DIR=/var/lib/terrain npm run invite-admin -- https://carte.raphaelgosset.fr
> ```

## 4. Mettre à jour l'app

Depuis ton PC, pousse tes modifications sur GitHub (`git push`), puis lance :
```powershell
ssh root@203.0.113.42 "bash /opt/terrain/deploy/update.sh"
```
Le script fait une sauvegarde, récupère le code, recompile et redémarre l'app. Les données sont conservées.

## 5. Sauvegardes

- Elles sont rangées sur le serveur dans `/var/backups/terrain/<date>/` : la base `terrain.db` et le dossier `uploads/` (les photos).
- Pour en récupérer une copie sur ton PC, de temps en temps :
  ```powershell
  scp -r root@203.0.113.42:/var/backups/terrain .\sauvegardes-terrain
  ```
- Pour lancer une sauvegarde tout de suite : `systemctl start terrain-backup`.

**Restaurer** une sauvegarde :
```bash
systemctl stop terrain
cp /var/backups/terrain/<date>/terrain.db /var/lib/terrain/terrain.db
rm -f /var/lib/terrain/terrain.db-wal /var/lib/terrain/terrain.db-shm
rm -rf /var/lib/terrain/uploads && cp -r /var/backups/terrain/<date>/uploads /var/lib/terrain/
chown -R terrain:terrain /var/lib/terrain
systemctl start terrain
```

## 6. En cas de souci

| Symptôme | À faire |
|---|---|
| Le site ne répond pas | `systemctl status terrain` puis `journalctl -u terrain -n 50` |
| Erreur de certificat HTTPS | Le DNS ne pointe pas encore vers le VPS (étape 2). Une fois corrigé : `systemctl reload caddy`, puis consulte `journalctl -u caddy -n 50` |
| La géolocalisation ou la caméra ne marchent pas | Vérifie que tu es bien en `https://` |
| Un appareil perdu ou volé | Onglet **Équipe** → l'appareil → **Retirer l'accès** (avec ou sans sa chaîne d'invités) |

## 7. Pour aller plus loin (facultatif)

Une fois que la connexion par clé SSH fonctionne, interdis la connexion par mot de passe :
```bash
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl reload ssh
```
