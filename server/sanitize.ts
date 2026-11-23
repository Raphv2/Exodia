/**
 * server/sanitize.ts — Retire les métadonnées des fichiers envoyés, côté serveur.
 *
 * Pourquoi ? Une photo prise au téléphone contient souvent des données EXIF : position GPS exacte,
 * modèle du téléphone, date. Un PDF contient l'auteur (souvent le nom de la personne), le logiciel…
 * Dans une app militante, ces informations peuvent identifier quelqu'un. Le navigateur recompresse
 * déjà les photos (ce qui retire l'EXIF), mais le serveur ne doit pas dépendre de ce que fait le
 * client : il nettoie lui-même tout ce qu'il reçoit.
 *
 * - JPEG : on parcourt les « segments » du fichier et on supprime APP1 (EXIF et XMP), APP13
 *   (IPTC/Photoshop) et les commentaires (COM). L'image elle-même n'est pas touchée.
 * - PNG : on supprime les « chunks » de texte et d'EXIF (tEXt, zTXt, iTXt, eXIf, tIME).
 * - PDF : on efface en place (remplacement par des espaces, même longueur : les positions internes
 *   du fichier restent valides) les champs Author, Creator, Producer, Subject, Keywords et le bloc
 *   XMP. C'est un nettoyage « au mieux » : un PDF qui compresse ses métadonnées n'est pas nettoyé,
 *   d'où l'avertissement qui reste affiché dans l'app.
 * - WebP / texte : laissés tels quels (le client envoie toujours ses photos en JPEG).
 */

/** JPEG sans ses segments de métadonnées. En cas de structure inattendue, renvoie l'original. */
export function stripJpeg(buf: Buffer): Buffer {
  // Un JPEG commence par FF D8 (SOI = début d'image).
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf; // structure inattendue : on ne touche à rien
    const marker = buf[i + 1];
    // SOS (FF DA) : début des données de l'image ; tout le reste est copié tel quel.
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); }
    // Marqueurs sans longueur (RSTn, TEM) : rares avant SOS, on les recopie.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    // Longueur du segment (2 octets, gros-boutiste), qui inclut ces 2 octets eux-mêmes.
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf;
    const drop = marker === 0xe1 /* APP1 : EXIF, XMP */ || marker === 0xed /* APP13 : IPTC */ || marker === 0xfe /* COM */;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;
}

/** PNG sans ses chunks de texte / EXIF / date. */
export function stripPng(buf: Buffer): Buffer {
  // Signature PNG (8 octets) puis des chunks : longueur (4) + type (4) + données + CRC (4).
  if (buf.length < 8) return buf;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return buf;
    if (!DROP.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

/** PDF dont les métadonnées lisibles sont effacées en place (même taille de fichier). */
export function scrubPdf(buf: Buffer): Buffer {
  // latin1 : un caractère = un octet, ce qui garantit que les remplacements gardent les positions.
  let s = buf.toString('latin1');
  const blank = (m: string) => ' '.repeat(m.length);
  // /Author (Jean Dupont)  ou  /Author <FEFF004A…> : on remplace la VALEUR par des espaces dans
  // les délimiteurs, pour rester un PDF valide : (       ) ou <        >.
  s = s.replace(/\/(Author|Creator|Producer|Subject|Keywords)\s*\(((?:\\.|[^\\)])*)\)/g,
    (all, _k, v: string) => all.slice(0, all.length - v.length - 1) + blank(v) + ')');
  s = s.replace(/\/(Author|Creator|Producer|Subject|Keywords)\s*<([0-9A-Fa-f\s]*)>/g,
    (all, _k, v: string) => all.slice(0, all.length - v.length - 1) + blank(v) + '>');
  // Bloc XMP non compressé : tout ce qui est entre <x:xmpmeta …> et </x:xmpmeta> devient des espaces.
  s = s.replace(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g, blank);
  return Buffer.from(s, 'latin1');
}

/** Nettoie un fichier selon son type réel (déjà reconnu par « sniff »). */
export function sanitize(buf: Buffer, ext: string): Buffer {
  try {
    if (ext === 'jpg') return stripJpeg(buf);
    if (ext === 'png') return stripPng(buf);
    if (ext === 'pdf') return scrubPdf(buf);
  } catch { /* au pire on garde l'original plutôt que de perdre le fichier */ }
  return buf;
}
