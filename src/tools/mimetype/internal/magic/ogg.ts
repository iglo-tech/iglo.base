// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/ogg.go.

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

const oggSig = lit("\x4F\x67\x67\x53\x00");
// Ogg matches an Ogg file.
export function Ogg(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, oggSig);
}

const audioSigs = [lit("\x7fFLAC"), lit("\x01vorbis"), lit("OpusHead"), lit("Speex\x20\x20\x20")];
// OggAudio matches an audio ogg file.
export function OggAudio(raw: Uint8Array, _limit: number): boolean {
  return raw.length >= 37 && audioSigs.some((s) => hasPrefix(raw.subarray(28), s));
}

const videoSigs = [lit("\x80theora"), lit("fishead\x00"), lit("\x01video\x00\x00\x00")];
// OggVideo matches a video ogg file.
export function OggVideo(raw: Uint8Array, _limit: number): boolean {
  return raw.length >= 37 && videoSigs.some((s) => hasPrefix(raw.subarray(28), s)); // OGM video
}
