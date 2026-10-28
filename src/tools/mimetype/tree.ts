// Upstream: gabriel-vasile/mimetype v1.4.15 tree.go.
//
// mimetype stores the list of MIME types in a tree structure with
// "application/octet-stream" at the root of the hierarchy. The hierarchy
// approach minimizes the number of checks that need to be done on the input
// and allows for more precise results once the base type of file has been
// identified.
//
// Go declares the nodes in any order; here a node is declared after its
// children (generated from tree.go in that order). Each node's children keep
// Go's order, which is the order they are tried in. Go's mutex guards the
// tree against Extend, which is left out, so the tree never changes.

import {
  Ar,
  Bz2,
  CRX,
  Cab,
  Cpio,
  Deb,
  Fits,
  Gzip,
  InstallShieldCab,
  Lzip,
  RAR,
  RPM,
  SevenZ,
  Tar,
  Warc,
  Xar,
  Xz,
  Zlib,
  Zstd,
} from "@/tools/mimetype/internal/magic/archive";
import {
  AAC,
  Aiff,
  Amr,
  Ape,
  Au,
  Flac,
  M3U,
  MP3,
  Midi,
  MusePack,
  Qcp,
  Voc,
  Wav,
} from "@/tools/mimetype/internal/magic/audio";
import {
  CBOR,
  Class,
  Dbf,
  Dcm,
  Elf,
  ElfDump,
  ElfExe,
  ElfLib,
  ElfObj,
  Exe,
  GLB,
  Lnk,
  MachO,
  Marc,
  Nes,
  Par1,
  Pcap,
  Pyc,
  SWF,
  Torrent,
  TzIf,
  Wasm,
} from "@/tools/mimetype/internal/magic/binary";
import { MsAccessAce, MsAccessMdb, Sqlite } from "@/tools/mimetype/internal/magic/database";
import {
  CHM,
  DjVu,
  Fdf,
  FrameMaker,
  Hlp,
  Inf,
  Lit,
  Lotus123,
  Mobi,
  P7s,
  PDF,
} from "@/tools/mimetype/internal/magic/document";
import { Eot, Otf, Ttc, Ttf, Woff, Woff2 } from "@/tools/mimetype/internal/magic/font";
import {
  AMp4,
  AVIF,
  Dvb,
  Heic,
  HeicSequence,
  Heif,
  HeifSequence,
  M4a,
  M4v,
  Mj2,
  Mp4,
  Mqv,
  QuickTime,
  ThreeG2,
  ThreeGP,
} from "@/tools/mimetype/internal/magic/ftyp";
import { Shp, Shx } from "@/tools/mimetype/internal/magic/geo";
import {
  Apng,
  Bmp,
  Bpg,
  DXF,
  Dwg,
  Gbr,
  Gif,
  Hdr,
  Icns,
  Ico,
  Jp2,
  Jpg,
  Jpm,
  Jpx,
  Jxl,
  Jxr,
  Jxs,
  Pat,
  Png,
  Ps,
  Psd,
  Tiff,
  Webp,
  Xcf,
  Xpm,
} from "@/tools/mimetype/internal/magic/image";
import { BUFR, GRIB } from "@/tools/mimetype/internal/magic/meteo";
import {
  Doc,
  Docx,
  Msg,
  Msi,
  Ole,
  One,
  Ppt,
  Pptx,
  Pub,
  Visio,
  WPD,
  Xls,
  Xlsx,
} from "@/tools/mimetype/internal/magic/ms-office";
import { NetPAM, NetPBM, NetPGM, NetPPM } from "@/tools/mimetype/internal/magic/netpbm";
import { Ogg, OggAudio, OggVideo } from "@/tools/mimetype/internal/magic/ogg";
import {
  Amf,
  Atom,
  CDXJSON,
  CDXXML,
  Collada,
  GEDCOM,
  GLTF,
  GeoJSON,
  Gml,
  Gpx,
  HAR,
  HTML,
  ICalendar,
  JSON,
  Js,
  Kml,
  Lua,
  NdJSON,
  Owl2,
  Perl,
  Php,
  Python,
  RFC822,
  Rss,
  Rtf,
  Ruby,
  Shell,
  Srt,
  Svg,
  Tcl,
  Tcx,
  Text,
  Threemf,
  VCard,
  Vtt,
  X3d,
  XHTML,
  XML,
  Xfdf,
  Xliff,
} from "@/tools/mimetype/internal/magic/text";
import { CSV, TSV } from "@/tools/mimetype/internal/magic/text-csv";
import { Asf, Avi, Flv, Mkv, Mpeg, Rmvb, WebM } from "@/tools/mimetype/internal/magic/video";
import {
  APK,
  Epub,
  Jar,
  KMZ,
  Odc,
  Odf,
  Odg,
  Odp,
  Ods,
  Odt,
  Otg,
  Otp,
  Ots,
  Ott,
  Sxc,
  Zip,
} from "@/tools/mimetype/internal/magic/zip";
import { newMIME } from "@/tools/mimetype/mime";

// The list of nodes appended to the root node.
export const xz = newMIME("application/x-xz", ".xz", Xz);
export const gzip = newMIME("application/gzip", ".gz", Gzip).alias(
  "application/x-gzip",
  "application/x-gunzip",
  "application/gzipped",
  "application/gzip-compressed",
  "application/x-gzip-compressed",
  "gzip/document",
);
export const sevenZ = newMIME("application/x-7z-compressed", ".7z", SevenZ);
export const docx = newMIME(
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
  Docx,
);
export const pptx = newMIME(
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptx",
  Pptx,
);
export const xlsx = newMIME(
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsx",
  Xlsx,
);
export const epub = newMIME("application/epub+zip", ".epub", Epub);
export const apk = newMIME("application/vnd.android.package-archive", ".apk", APK);
export const jar = newMIME("application/java-archive", ".jar", Jar).alias(
  "application/jar",
  "application/jar-archive",
  "application/x-java-archive",
);
export const ott = newMIME("application/vnd.oasis.opendocument.text-template", ".ott", Ott).alias(
  "application/x-vnd.oasis.opendocument.text-template",
);
export const odt = newMIME("application/vnd.oasis.opendocument.text", ".odt", Odt, ott).alias(
  "application/x-vnd.oasis.opendocument.text",
);
export const ots = newMIME(
  "application/vnd.oasis.opendocument.spreadsheet-template",
  ".ots",
  Ots,
).alias("application/x-vnd.oasis.opendocument.spreadsheet-template");
export const ods = newMIME(
  "application/vnd.oasis.opendocument.spreadsheet",
  ".ods",
  Ods,
  ots,
).alias("application/x-vnd.oasis.opendocument.spreadsheet");
export const otp = newMIME(
  "application/vnd.oasis.opendocument.presentation-template",
  ".otp",
  Otp,
).alias("application/x-vnd.oasis.opendocument.presentation-template");
export const odp = newMIME(
  "application/vnd.oasis.opendocument.presentation",
  ".odp",
  Odp,
  otp,
).alias("application/x-vnd.oasis.opendocument.presentation");
export const otg = newMIME(
  "application/vnd.oasis.opendocument.graphics-template",
  ".otg",
  Otg,
).alias("application/x-vnd.oasis.opendocument.graphics-template");
export const odg = newMIME("application/vnd.oasis.opendocument.graphics", ".odg", Odg, otg).alias(
  "application/x-vnd.oasis.opendocument.graphics",
);
export const odf = newMIME("application/vnd.oasis.opendocument.formula", ".odf", Odf).alias(
  "application/x-vnd.oasis.opendocument.formula",
);
export const odc = newMIME("application/vnd.oasis.opendocument.chart", ".odc", Odc).alias(
  "application/x-vnd.oasis.opendocument.chart",
);
export const sxc = newMIME("application/vnd.sun.xml.calc", ".sxc", Sxc);
export const kmz = newMIME("application/vnd.google-earth.kmz", ".kmz", KMZ);
export const visio = newMIME("application/vnd.ms-visio.drawing.main+xml", ".vsdx", Visio);
// APK must be checked before JAR because APK is a subset of JAR.
// This means APK should be a child of JAR detector, but in practice,
// the decisive signature for JAR might be located at the end of the file
// and not reachable because of library readLimit.
export const zip = newMIME(
  "application/zip",
  ".zip",
  Zip,
  docx,
  pptx,
  xlsx,
  epub,
  apk,
  jar,
  odt,
  ods,
  odp,
  odg,
  odf,
  odc,
  sxc,
  kmz,
  visio,
).alias("application/x-zip", "application/x-zip-compressed");
export const tar = newMIME("application/x-tar", ".tar", Tar);
export const xar = newMIME("application/x-xar", ".xar", Xar);
export const bz2 = newMIME("application/x-bzip2", ".bz2", Bz2);
export const pdf = newMIME("application/pdf", ".pdf", PDF).alias("application/x-pdf");
export const fdf = newMIME("application/vnd.fdf", ".fdf", Fdf);
export const msi = newMIME("application/x-ms-installer", ".msi", Msi).alias(
  "application/x-windows-installer",
  "application/x-msi",
);
export const msg = newMIME("application/vnd.ms-outlook", ".msg", Msg);
export const xls = newMIME("application/vnd.ms-excel", ".xls", Xls).alias("application/msexcel");
export const pub = newMIME("application/vnd.ms-publisher", ".pub", Pub);
export const ppt = newMIME("application/vnd.ms-powerpoint", ".ppt", Ppt).alias(
  "application/mspowerpoint",
);
export const doc = newMIME("application/msword", ".doc", Doc).alias("application/vnd.ms-word");
export const ole = newMIME("application/x-ole-storage", "", Ole, msi, msg, xls, pub, ppt, doc);
export const ps = newMIME("application/postscript", ".ps", Ps);
export const fits = newMIME("application/fits", ".fits", Fits).alias("image/fits");
export const oggAudio = newMIME("audio/ogg", ".oga", OggAudio);
export const oggVideo = newMIME("video/ogg", ".ogv", OggVideo);
export const ogg = newMIME("application/ogg", ".ogg", Ogg, oggAudio, oggVideo).alias(
  "application/x-ogg",
);
export const svg = newMIME("image/svg+xml", ".svg", Svg);
export const html = newMIME("text/html", ".html", HTML);
export const rss = newMIME("application/rss+xml", ".rss", Rss).alias("text/rss");
export const atom = newMIME("application/atom+xml", ".atom", Atom);
export const x3d = newMIME("model/x3d+xml", ".x3d", X3d);
export const kml = newMIME("application/vnd.google-earth.kml+xml", ".kml", Kml);
export const xliff = newMIME("application/x-xliff+xml", ".xlf", Xliff);
export const collada = newMIME("model/vnd.collada+xml", ".dae", Collada);
export const gml = newMIME("application/gml+xml", ".gml", Gml);
export const gpx = newMIME("application/gpx+xml", ".gpx", Gpx);
export const tcx = newMIME("application/vnd.garmin.tcx+xml", ".tcx", Tcx);
export const amf = newMIME("application/x-amf", ".amf", Amf);
export const threemf = newMIME(
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
  ".3mf",
  Threemf,
);
export const xfdf = newMIME("application/vnd.adobe.xfdf", ".xfdf", Xfdf);
export const owl2 = newMIME("application/owl+xml", ".owl", Owl2);
export const xhtml = newMIME("application/xhtml+xml", ".html", XHTML);
export const cdxxml = newMIME("application/vnd.cyclonedx+xml", ".xml", CDXXML);
export const xml = newMIME(
  "text/xml",
  ".xml",
  XML,
  rss,
  atom,
  x3d,
  kml,
  xliff,
  collada,
  gml,
  gpx,
  tcx,
  amf,
  threemf,
  xfdf,
  owl2,
  xhtml,
  cdxxml,
).alias("application/xml");
export const php = newMIME("text/x-php", ".php", Php);
export const js = newMIME("text/javascript", ".js", Js).alias(
  "application/x-javascript",
  "application/javascript",
);
export const lua = newMIME("text/x-lua", ".lua", Lua);
export const perl = newMIME("text/x-perl", ".pl", Perl);
export const python = newMIME("text/x-python", ".py", Python).alias(
  "text/x-script.python",
  "application/x-python",
);
export const ruby = newMIME("text/x-ruby", ".rb", Ruby).alias("application/x-ruby");
export const geoJSON = newMIME("application/geo+json", ".geojson", GeoJSON);
export const har = newMIME("application/json", ".har", HAR);
export const gltf = newMIME("model/gltf+json", ".gltf", GLTF);
export const cdxJSON = newMIME("application/vnd.cyclonedx+json", ".json", CDXJSON);
export const json = newMIME("application/json", ".json", JSON, geoJSON, har, gltf, cdxJSON);
export const ndJSON = newMIME("application/x-ndjson", ".ndjson", NdJSON);
export const rtf = newMIME("text/rtf", ".rtf", Rtf).alias("application/rtf");
export const srt = newMIME("application/x-subrip", ".srt", Srt).alias(
  "application/x-srt",
  "text/x-srt",
);
export const tcl = newMIME("text/x-tcl", ".tcl", Tcl).alias("application/x-tcl");
export const csv = newMIME("text/csv", ".csv", CSV);
export const tsv = newMIME("text/tab-separated-values", ".tsv", TSV);
export const vCard = newMIME("text/vcard", ".vcf", VCard);
export const iCalendar = newMIME("text/calendar", ".ics", ICalendar);
export const warc = newMIME("application/warc", ".warc", Warc);
export const vtt = newMIME("text/vtt", ".vtt", Vtt);
export const shell = newMIME("text/x-shellscript", ".sh", Shell).alias(
  "text/x-sh",
  "application/x-shellscript",
  "application/x-sh",
);
export const netpbm = newMIME("image/x-portable-bitmap", ".pbm", NetPBM);
export const netpgm = newMIME("image/x-portable-graymap", ".pgm", NetPGM);
export const netppm = newMIME("image/x-portable-pixmap", ".ppm", NetPPM);
export const netpam = newMIME("image/x-portable-arbitrarymap", ".pam", NetPAM);
export const rfc822 = newMIME("message/rfc822", ".eml", RFC822);
export const gedcom = newMIME("text/vnd.familysearch.gedcom", ".ged", GEDCOM);
export const text = newMIME(
  "text/plain",
  ".txt",
  Text,
  svg,
  html,
  xml,
  php,
  js,
  lua,
  perl,
  python,
  ruby,
  json,
  ndJSON,
  rtf,
  srt,
  tcl,
  csv,
  tsv,
  vCard,
  iCalendar,
  warc,
  vtt,
  shell,
  netpbm,
  netpgm,
  netppm,
  netpam,
  rfc822,
  gedcom,
);
export const pyc = newMIME("application/x-bytecode.python", ".pyc", Pyc);
export const apng = newMIME("image/apng", ".apng", Apng).alias("image/vnd.mozilla.apng");
export const png = newMIME("image/png", ".png", Png, apng);
export const jpg = newMIME("image/jpeg", ".jpg", Jpg);
export const jxl = newMIME("image/jxl", ".jxl", Jxl);
export const jp2 = newMIME("image/jp2", ".jp2", Jp2);
export const jpx = newMIME("image/jpx", ".jpf", Jpx);
export const jpm = newMIME("image/jpm", ".jpm", Jpm).alias("video/jpm");
export const jxs = newMIME("image/jxs", ".jxs", Jxs);
export const xpm = newMIME("image/x-xpixmap", ".xpm", Xpm);
export const bpg = newMIME("image/bpg", ".bpg", Bpg);
export const gif = newMIME("image/gif", ".gif", Gif);
export const webp = newMIME("image/webp", ".webp", Webp);
export const tiff = newMIME("image/tiff", ".tiff", Tiff);
export const bmp = newMIME("image/bmp", ".bmp", Bmp).alias("image/x-bmp", "image/x-ms-bmp");
// lotus check must be done before ico because some ico detection is a bit
// relaxed and some lotus files are wrongfully identified as ico otherwise.
export const lotus = newMIME("application/vnd.lotus-1-2-3", ".123", Lotus123);
export const ico = newMIME("image/x-icon", ".ico", Ico);
export const icns = newMIME("image/x-icns", ".icns", Icns);
export const psd = newMIME("image/vnd.adobe.photoshop", ".psd", Psd).alias(
  "image/x-psd",
  "application/photoshop",
);
export const heic = newMIME("image/heic", ".heic", Heic);
export const heicSeq = newMIME("image/heic-sequence", ".heic", HeicSequence);
export const heif = newMIME("image/heif", ".heif", Heif);
export const heifSeq = newMIME("image/heif-sequence", ".heif", HeifSequence);
export const hdr = newMIME("image/vnd.radiance", ".hdr", Hdr);
export const avif = newMIME("image/avif", ".avif", AVIF);
export const mp3 = newMIME("audio/mpeg", ".mp3", MP3).alias("audio/x-mpeg", "audio/mp3");
export const flac = newMIME("audio/flac", ".flac", Flac);
export const midi = newMIME("audio/midi", ".midi", Midi).alias(
  "audio/mid",
  "audio/sp-midi",
  "audio/x-mid",
  "audio/x-midi",
);
export const ape = newMIME("audio/ape", ".ape", Ape);
export const musePack = newMIME("audio/musepack", ".mpc", MusePack);
export const wav = newMIME("audio/wav", ".wav", Wav).alias(
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/wave",
);
export const aiff = newMIME("audio/aiff", ".aiff", Aiff).alias("audio/x-aiff");
export const au = newMIME("audio/basic", ".au", Au);
export const amr = newMIME("audio/amr", ".amr", Amr).alias("audio/amr-nb");
export const aac = newMIME("audio/aac", ".aac", AAC);
export const voc = newMIME("audio/x-unknown", ".voc", Voc);
export const aMp4 = newMIME("audio/mp4", ".mp4", AMp4).alias("audio/x-mp4a");
export const m4a = newMIME("audio/x-m4a", ".m4a", M4a);
export const m3u = newMIME("application/vnd.apple.mpegurl", ".m3u", M3U).alias(
  "audio/mpegurl",
  "application/x-mpegurl",
);
export const m4v = newMIME("video/x-m4v", ".m4v", M4v);
export const mj2 = newMIME("video/mj2", ".mj2", Mj2);
export const dvb = newMIME("video/vnd.dvb.file", ".dvb", Dvb);
export const threeGP = newMIME("video/3gpp", ".3gp", ThreeGP).alias("video/3gp", "audio/3gpp");
export const threeG2 = newMIME("video/3gpp2", ".3g2", ThreeG2).alias("video/3g2", "audio/3gpp2");
export const mqv = newMIME("video/quicktime", ".mqv", Mqv);
export const mp4 = newMIME(
  "video/mp4",
  ".mp4",
  Mp4,
  avif,
  threeGP,
  threeG2,
  aMp4,
  mqv,
  m4a,
  m4v,
  heic,
  heicSeq,
  heif,
  heifSeq,
  mj2,
  dvb,
);
export const webM = newMIME("video/webm", ".webm", WebM).alias("audio/webm");
export const mpeg = newMIME("video/mpeg", ".mpeg", Mpeg);
export const quickTime = newMIME("video/quicktime", ".mov", QuickTime);
export const avi = newMIME("video/x-msvideo", ".avi", Avi).alias("video/avi", "video/msvideo");
export const flv = newMIME("video/x-flv", ".flv", Flv);
export const mkv = newMIME("video/matroska", ".mkv", Mkv).alias("video/x-matroska");
export const asf = newMIME("video/x-ms-asf", ".asf", Asf).alias("video/asf", "video/x-ms-wmv");
export const rmvb = newMIME("application/vnd.rn-realmedia-vbr", ".rmvb", Rmvb);
export const classFile = newMIME("application/x-java-applet", ".class", Class);
export const swf = newMIME("application/x-shockwave-flash", ".swf", SWF);
export const crx = newMIME("application/x-chrome-extension", ".crx", CRX);
export const ttf = newMIME("font/ttf", ".ttf", Ttf).alias(
  "font/sfnt",
  "application/x-font-ttf",
  "application/font-sfnt",
);
export const woff = newMIME("font/woff", ".woff", Woff);
export const woff2 = newMIME("font/woff2", ".woff2", Woff2);
export const otf = newMIME("font/otf", ".otf", Otf);
export const ttc = newMIME("font/collection", ".ttc", Ttc);
export const eot = newMIME("application/vnd.ms-fontobject", ".eot", Eot);
export const wasm = newMIME("application/wasm", ".wasm", Wasm);
export const shp = newMIME("application/vnd.shp", ".shp", Shp);
export const shx = newMIME("application/vnd.shx", ".shx", Shx, shp);
export const dbf = newMIME("application/x-dbf", ".dbf", Dbf);
export const exe = newMIME("application/vnd.microsoft.portable-executable", ".exe", Exe);
export const elfObj = newMIME("application/x-object", "", ElfObj);
export const elfExe = newMIME("application/x-executable", "", ElfExe);
export const elfLib = newMIME("application/x-sharedlib", ".so", ElfLib);
export const elfDump = newMIME("application/x-coredump", "", ElfDump);
export const elf = newMIME("application/x-elf", "", Elf, elfObj, elfExe, elfLib, elfDump);
export const deb = newMIME("application/vnd.debian.binary-package", ".deb", Deb);
export const ar = newMIME("application/x-archive", ".a", Ar, deb).alias(
  "application/x-unix-archive",
);
export const rpm = newMIME("application/x-rpm", ".rpm", RPM);
export const dcm = newMIME("application/dicom", ".dcm", Dcm);
export const rar = newMIME("application/vnd.rar", ".rar", RAR).alias(
  "application/x-rar-compressed",
  "application/x-rar",
);
export const djvu = newMIME("image/vnd.djvu", ".djvu", DjVu);
export const mobi = newMIME("application/x-mobipocket-ebook", ".mobi", Mobi);
export const lit = newMIME("application/x-ms-reader", ".lit", Lit);
export const sqlite3 = newMIME("application/vnd.sqlite3", ".sqlite", Sqlite).alias(
  "application/x-sqlite3",
);
export const dwg = newMIME("image/vnd.dwg", ".dwg", Dwg).alias(
  "image/x-dwg",
  "application/acad",
  "application/x-acad",
  "application/autocad_dwg",
  "application/dwg",
  "application/x-dwg",
  "application/x-autocad",
  "drawing/dwg",
);
export const nes = newMIME("application/vnd.nintendo.snes.rom", ".nes", Nes);
export const lnk = newMIME("application/x-ms-shortcut", ".lnk", Lnk);
export const macho = newMIME("application/x-mach-binary", ".macho", MachO);
export const qcp = newMIME("audio/qcelp", ".qcp", Qcp);
export const mrc = newMIME("application/marc", ".mrc", Marc);
export const mdb = newMIME("application/x-msaccess", ".mdb", MsAccessMdb);
export const accdb = newMIME("application/x-msaccess", ".accdb", MsAccessAce);
export const zstd = newMIME("application/zstd", ".zst", Zstd);
export const cab = newMIME("application/vnd.ms-cab-compressed", ".cab", Cab);
export const cabIS = newMIME("application/x-installshield", ".cab", InstallShieldCab);
export const lzip = newMIME("application/lzip", ".lz", Lzip).alias("application/x-lzip");
export const torrent = newMIME("application/x-bittorrent", ".torrent", Torrent);
export const cpio = newMIME("application/x-cpio", ".cpio", Cpio);
export const tzif = newMIME("application/tzif", "", TzIf);
export const p7s = newMIME("application/pkcs7-signature", ".p7s", P7s);
export const xcf = newMIME("image/x-xcf", ".xcf", Xcf);
export const pat = newMIME("image/x-gimp-pat", ".pat", Pat);
export const gbr = newMIME("image/x-gimp-gbr", ".gbr", Gbr);
export const glb = newMIME("model/gltf-binary", ".glb", GLB);
export const jxr = newMIME("image/jxr", ".jxr", Jxr).alias("image/vnd.ms-photo");
export const parquet = newMIME("application/vnd.apache.parquet", ".parquet", Par1).alias(
  "application/x-parquet",
);
export const cbor = newMIME("application/cbor", ".cbor", CBOR);
export const oneNote = newMIME("application/onenote", ".one", One);
export const chm = newMIME("application/vnd.ms-htmlhelp", ".chm", CHM);
export const wpd = newMIME("application/vnd.wordperfect", ".wpd", WPD);
export const dxf = newMIME("image/vnd.dxf", ".dxf", DXF);
export const grib = newMIME("application/grib", ".grb", GRIB);
export const zlib = newMIME("application/zlib", "", Zlib);
export const inf = newMIME("application/x-os2-inf", ".inf", Inf);
export const hlp = newMIME("application/x-os2-hlp", ".hlp", Hlp);
export const fm = newMIME("application/vnd.framemaker", ".fm", FrameMaker);
export const bufr = newMIME("application/bufr", ".bufr", BUFR);
export const pcap = newMIME("application/vnd.tcpdump.pcap", ".pcap", Pcap);

// root is a detector which passes for any slice of bytes.
// When a detector passes the check, the children detectors
// are tried in order to find a more accurate MIME type.
export const root = newMIME(
  "application/octet-stream",
  "",
  () => true,
  xpm,
  sevenZ,
  zip,
  pdf,
  fdf,
  ole,
  ps,
  psd,
  p7s,
  ogg,
  png,
  jpg,
  jxl,
  jp2,
  jpx,
  jpm,
  jxs,
  gif,
  webp,
  exe,
  elf,
  ar,
  tar,
  xar,
  bz2,
  fits,
  tiff,
  bmp,
  lotus,
  ico,
  flac,
  midi,
  ape,
  musePack,
  amr,
  wav,
  aiff,
  au,
  mpeg,
  quickTime,
  mp4,
  webM,
  avi,
  flv,
  mkv,
  asf,
  aac,
  voc,
  m3u,
  rmvb,
  gzip,
  classFile,
  swf,
  crx,
  ttf,
  woff,
  woff2,
  otf,
  ttc,
  eot,
  wasm,
  shx,
  dbf,
  dcm,
  rar,
  djvu,
  mobi,
  lit,
  bpg,
  cbor,
  sqlite3,
  dwg,
  nes,
  lnk,
  macho,
  qcp,
  icns,
  hdr,
  mrc,
  mdb,
  accdb,
  zstd,
  cab,
  rpm,
  xz,
  lzip,
  torrent,
  cpio,
  tzif,
  xcf,
  pat,
  gbr,
  glb,
  cabIS,
  jxr,
  parquet,
  oneNote,
  chm,
  wpd,
  dxf,
  grib,
  zlib,
  inf,
  hlp,
  fm,
  bufr,
  pyc,
  pcap,
  // MP3 is late because it does a linear search in the input. That means
  // containers that embed an MP3, for example: an mp4 file, or a zip without
  // compression, would pass as MP3s.
  mp3,
  // Keep text last because it is the slowest check.
  text,
);

// errMIME is returned from Detect functions when err is not nil.
// Detect could return root for erroneous cases, but it needs to lock mu in order to do so.
// errMIME is same as root but it does not require locking.
export const errMIME = newMIME("application/octet-stream", "", () => false);
