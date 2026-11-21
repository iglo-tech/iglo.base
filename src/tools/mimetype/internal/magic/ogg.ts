// Upstream: gabriel-vasile/mimetype v1.4.16 internal/magic/ogg.go.

import { hasPrefix, lit } from "@/tools/mimetype/go-bytes";

/*
 NOTE:

 In May 2003, two Internet RFCs were published relating to the format.
 The Ogg bitstream was defined in RFC 3533 (which is classified as
 'informative') and its Internet content type (application/ogg) in RFC
 3534 (which is, as of 2006, a proposed standard protocol). In
 September 2008, RFC 3534 was obsoleted by RFC 5334, which added
 content types video/ogg, audio/ogg and filename extensions .ogx, .ogv,
 .oga, .spx.

 See:
 https://tools.ietf.org/html/rfc3533
 https://developer.mozilla.org/en-US/docs/Web/HTTP/Configuring_servers_for_Ogg_media#Serve_media_with_the_correct_MIME_type
 https://github.com/file/file/blob/master/magic/Magdir/vorbis
*/

const oggSig = lit("\u004F\u0067\u0067\u0053\u0000");
// Ogg matches an Ogg file.
export function Ogg(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, oggSig);
}

const audioSigs = [
  lit("\u007fFLAC"),
  lit("\u0001vorbis"),
  lit("OpusHead"),
  lit("Speex\u0020\u0020\u0020"),
];
// OggAudio matches an audio ogg file.
export function OggAudio(raw: Uint8Array, _limit: number): boolean {
  return raw.length >= 37 && audioSigs.some((s) => hasPrefix(raw.subarray(28), s));
}

const videoSigs = [lit("\u0080theora"), lit("fishead\u0000"), lit("\u0001video\u0000\u0000\u0000")];
// OggVideo matches a video ogg file.
export function OggVideo(raw: Uint8Array, _limit: number): boolean {
  return raw.length >= 37 && videoSigs.some((s) => hasPrefix(raw.subarray(28), s)); // OGM video
}
